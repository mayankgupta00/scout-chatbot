# SCP Support Chatbot

A simple, self-hosted customer support chatbot. It knows everything in
`data/knowledge.txt` (built from your Service Code Provisioning document),
and can also search the web when it needs to.

## What's inside

```
scp-chatbot/
  server.js          <- the "brain" (talks to Claude)
  package.json        <- list of small libraries it needs
  public/index.html   <- the chat window your customers see
  data/knowledge.txt   <- your uploaded document, in plain text
  .env.example         <- template for your secret API key
```

## Step 1 — Run it on your own computer first

1. Install [Node.js](https://nodejs.org) if you don't have it (the LTS version).
2. Get a Claude API key at https://console.anthropic.com (Settings > API Keys).
3. In this folder, copy `.env.example` to a new file named `.env`, and paste
   your real API key in.
4. Open a terminal in this folder and run:
   ```
   npm install
   npm start
   ```
5. Open your browser to **http://localhost:3000** — your chatbot is live,
   just on your computer. Try asking it something from your document.

## Step 2 — Put it on a real, live server

Once it works locally, you have two easy options:

### Option A: Easiest — a hosting platform (Render, Railway, Fly.io)
These take a Node.js project like this one and run it on the internet for
you, without you managing a server yourself.
1. Push this folder to a GitHub repository.
2. Sign up at Render.com (or Railway.app).
3. Click "New Web Service", connect your GitHub repo.
4. Set the start command to `npm start`.
5. Add an environment variable: `ANTHROPIC_API_KEY` = your real key.
6. Deploy. You'll get a live URL like `https://your-bot.onrender.com`.

### Option B: Your own server (VPS — e.g. DigitalOcean, AWS EC2)
This is more control, more setup:
1. Rent a small server (a "droplet" or "instance").
2. Install Node.js on it.
3. Upload this folder to the server (e.g. using `git` or `scp`).
4. Create the `.env` file on the server with your real API key.
5. Run `npm install` then `npm start` — or better, use a tool called `pm2`
   so the bot keeps running even after you close the terminal:
   ```
   npm install -g pm2
   pm2 start server.js --name scp-chatbot
   ```
6. Point your domain name at the server, and use a tool like `nginx` to
   route traffic to it securely (with HTTPS).

## Step 3 — Put the chat window on your actual website

If your chatbot lives at `https://your-bot.onrender.com`, you can either:
- Send customers directly to that link, or
- Embed it inside your existing website using an `<iframe>`:
  ```html
  <iframe src="https://your-bot.onrender.com" width="420" height="640"></iframe>
  ```

## Updating what the bot knows

Just replace the text in `data/knowledge.txt` with updated info (or add
more), then restart the server. No re-training needed — it reads the file
fresh every time it starts.

## A few things to keep in mind

- **Costs**: every message costs a small amount via the Claude API. Keep an
  eye on usage in the Anthropic console, especially once real customers use it.
- **Keep your API key secret**: never put it in `index.html` or share the
  `.env` file — only the server should know it.
- **This is a starting point**: for a bigger knowledge base (many documents),
  you'd eventually want a proper search system instead of stuffing the whole
  document into every request. Ask me if you want to grow into that later.
