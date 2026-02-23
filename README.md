# MeritX Landing Page

This is the landing page for MeritX, an AI-powered intake and workflow system for law firms.

## Project Structure

- `index.html`: Main landing page structure.
- `css/styles.css`: Custom styling with a modern, dark-themed aesthetic.
- `js/script.js`: Interactive elements (mobile menu, smooth scrolling).
- `netlify.toml`: Deployment configuration for Netlify.

## Development

### Landing Page
To run the static landing page locally, simply open `index.html` in your browser.

### MVP Web Application (app folder)
The MVP uses a Node.js Express backend (to proxy AssemblyAI) and a Vite + React frontend. You must run both servers concurrently to use the MVP natively. 

1. **Start the Backend**
   ```bash
   cd app/server
   npm install
   # Ensure you have your ASSEMBLYAI_API_KEY inside app/server/.env
   npm run dev
   ```
   *Runs on `http://localhost:3001`*

2. **Start the Frontend**
   ```bash
   cd app/client
   npm install
   npm run dev
   ```
   *Runs on `http://localhost:5173`*

## Deployment

This site is ready for deployment on [Netlify](https://netlify.com).

1.  Push this repository to GitHub/GitLab/Bitbucket.
2.  Log in to Netlify and click "New site from Git".
3.  Select your repository.
4.  The `netbeans.toml` file will automatically configure the build settings (publish directory: `.`).
5.  Click "Deploy site".
