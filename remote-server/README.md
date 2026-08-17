# 🌐 Lapex Flash — Remote Server Deployment

This folder contains all necessary files to host **Lapex Flash** on a remote server, cloud provider (Render, Railway, Heroku, AWS), or Docker container.

## 🚀 Deployment Options

### Option 1: Render.com (Recommended Free Cloud Hosting)
1. Push your repository to GitHub.
2. Log in to [Render.com](https://render.com) and click **New > Web Service**.
3. Connect your GitHub repository and set the **Root Directory** to `remote-server`.
4. Render will auto-detect Node.js and build using `npm install` and `npm start`.
5. (Optional) Set Environment Variables in Render settings:
   - `SF_CLIENT_ID`
   - `SF_CLIENT_SECRET`

### Option 2: Docker Container
1. Open terminal in the `remote-server` directory.
2. Build the Docker image:
   ```bash
   docker build -t lapex-flash-remote .
   ```
3. Run the container:
   ```bash
   docker run -d -p 3000:3000 --name lapex-flash lapex-flash-remote
   ```
4. Access in browser at `http://localhost:3000/apex-executor.html`.

### Option 3: Linux / VPS Server (Ubuntu / Nginx)
1. Copy the `remote-server` folder to your server: `/var/www/lapex-flash`.
2. Run `npm install --production`.
3. Use `pm2` to keep it running:
   ```bash
   npm install -g pm2
   pm2 start server.js --name "lapex-flash"
   ```
