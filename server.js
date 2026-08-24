// server.js
// This is the "brain" of your chatbot. It runs on a server, receives
// messages from the chat window (public/index.html), sends them to
// Claude along with your knowledge document, and sends the reply back.
// It also handles login/signup so each customer only ever sees their own
// conversation history.

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-your-.env-file';
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET is not set in .env — using an insecure default. Set it before going live.');
}

// ---- 1. Load your knowledge document once when the server starts ----
const KNOWLEDGE_PATH = path.join(__dirname, 'data', 'knowledge.txt');
let knowledgeText = '';
try {
  knowledgeText = fs.readFileSync(KNOWLEDGE_PATH, 'utf-8');
  console.log(`Loaded knowledge base: ${knowledgeText.split(/\s+/).length} words`);
} catch (err) {
  console.warn('No knowledge.txt found in /data — bot will answer with general knowledge + web search only.');
}

// ---- 2. A very simple per-user "database" ----
// Users live in one JSON file. Each user's chat history lives in its own
// separate file, named by their user id, so one customer never sees
// another customer's conversation.
const USERS_PATH = path.join(__dirname, 'data', 'users.json');
const CONVERSATIONS_DIR = path.join(__dirname, 'data', 'conversations');
if (!fs.existsSync(CONVERSATIONS_DIR)) fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  } catch (err) {
    return {}; // no users yet
  }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
}
function conversationPath(userId) {
  return path.join(CONVERSATIONS_DIR, `${userId}.json`);
}
function loadConversation(userId) {
  try {
    return JSON.parse(fs.readFileSync(conversationPath(userId), 'utf-8'));
  } catch (err) {
    return [];
  }
}
function saveConversation(userId, messages) {
  fs.writeFileSync(conversationPath(userId), JSON.stringify(messages, null, 2));
}

// ---- 3. Auth: signup, login, and a middleware that checks the login token ----
app.post('/api/signup', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Email and a password of at least 6 characters are required.' });
  }
  const users = loadUsers();
  const key = email.toLowerCase().trim();
  if (users[key]) {
    return res.status(400).json({ error: 'An account with that email already exists. Try logging in instead.' });
  }
  const userId = crypto.randomUUID();
  users[key] = {
    id: userId,
    email: key,
    passwordHash: bcrypt.hashSync(password, 10),
    createdAt: new Date().toISOString(),
  };
  saveUsers(users);

  const token = jwt.sign({ userId, email: key }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, email: key });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  const users = loadUsers();
  const key = email.toLowerCase().trim();
  const user = users[key];
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, email: user.email });
});

// Every protected route checks for "Authorization: Bearer <token>" and, if
// valid, attaches the customer's id/email to the request.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Your session expired. Please log in again.' });
  }
}

// Lets the chat window load a customer's own past conversation right after login.
app.get('/api/history', requireAuth, (req, res) => {
  res.json({ messages: loadConversation(req.userId) });
});

// ---- 4. Build the system prompt every request uses ----
function buildSystemPrompt() {
  return `You are Scout, the support assistant for our product. Your job is to
go find the right answer for the customer, the way a good guide finds the
right trail — direct, reliable, and a little warm, never robotic.

Answer using the KNOWLEDGE DOCUMENT below whenever it's relevant — it is the
source of truth for how our system works. If the answer isn't in the
document and you have web search available, you may search the web. If you
still don't know, say so honestly instead of guessing.

Keep answers clear and to the point. Use plain language, not jargon, unless
the customer's question is technical. Avoid stiff corporate phrasing like
"I'd be happy to assist you" — just help.

LANGUAGE: Always reply in the same language the customer just wrote in,
even if the knowledge document itself is in English — translate the
relevant information naturally rather than answering in English by default.
If the customer switches languages mid-conversation, switch with them. If
their message mixes languages or you genuinely can't tell, default to
English and you may ask which language they'd prefer.

ESCALATION: If you cannot confidently answer from the knowledge document or
web search, or if the customer explicitly asks to speak with a person, end
your reply with the exact marker [[NEEDS_HUMAN]] on its own at the very
end (after a normal, helpful message telling them you'll loop in the team).
Do not explain the marker itself to the customer — it is removed before
they see your message.

--- KNOWLEDGE DOCUMENT START ---
${knowledgeText}
--- KNOWLEDGE DOCUMENT END ---`;
}

// ---- 5. The chat endpoint — now requires login, and saves history per-user ----
app.post('/api/chat', requireAuth, async (req, res) => {
  try {
    const { message } = req.body; // just the new message text from the customer

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Set it in your .env file.' });
    }

    // Load this customer's own history, add their new message, and cap how
    // much we send to Claude so a very long-running conversation doesn't
    // balloon in cost — the last 30 messages is plenty of context.
    const fullHistory = loadConversation(req.userId);
    fullHistory.push({ role: 'user', content: message, at: new Date().toISOString() });
    const contextMessages = fullHistory
      .slice(-30)
      .map((m) => ({ role: m.role, content: m.content }));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: buildSystemPrompt(),
        messages: contextMessages,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
    });

    const data = await response.json();

    if (data.error) {
      console.error('Anthropic API error:', data.error);
      return res.status(500).json({ error: data.error.message });
    }

    let replyText = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const needsHuman = replyText.includes('[[NEEDS_HUMAN]]');
    replyText = replyText.replace('[[NEEDS_HUMAN]]', '').trim();

    // Save both sides of the exchange into this customer's own file.
    fullHistory.push({ role: 'assistant', content: replyText, at: new Date().toISOString() });
    saveConversation(req.userId, fullHistory);

    res.json({ reply: replyText, needsHuman });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// ---- 6. Escalation: save a ticket and (optionally) email your support team ----
const ESCALATIONS_DIR = path.join(__dirname, 'data', 'escalations');
if (!fs.existsSync(ESCALATIONS_DIR)) fs.mkdirSync(ESCALATIONS_DIR, { recursive: true });

app.post('/api/escalate', requireAuth, async (req, res) => {
  try {
    // We already know who this customer is from their login — no need to
    // ask them for their email again.
    const email = req.userEmail;
    const messages = loadConversation(req.userId);

    if (!messages || messages.length === 0) {
      return res.status(400).json({ error: 'No conversation to send yet.' });
    }

    const ticket = {
      id: `ticket_${Date.now()}`,
      createdAt: new Date().toISOString(),
      customerEmail: email,
      conversation: messages,
    };

    const filePath = path.join(ESCALATIONS_DIR, `${ticket.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(ticket, null, 2));
    console.log(`New escalation saved: ${filePath}`);

    if (process.env.SMTP_HOST && process.env.SUPPORT_EMAIL) {
      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 587),
          secure: false,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });

        const transcript = messages
          .map((m) => `${m.role === 'user' ? 'Customer' : 'Scout'}: ${m.content}`)
          .join('\n\n');

        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: process.env.SUPPORT_EMAIL,
          subject: `Scout handoff — ${email}`,
          text: `A customer needs help.\n\nCustomer email: ${email}\n\n--- Conversation so far ---\n\n${transcript}`,
        });
        console.log('Escalation email sent to support team.');
      } catch (emailErr) {
        console.error('Could not send escalation email:', emailErr.message);
      }
    }

    res.json({ ok: true, ticketId: ticket.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong saving your request.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Chatbot server running at http://localhost:${PORT}`);
});
