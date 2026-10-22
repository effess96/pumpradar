# PumpRadar 24/7 server: headless Chromium runs the app's bots; the phone uses the same page as a remote control.
FROM mcr.microsoft.com/playwright:v1.48.2-noble
ENV NODE_ENV=production DATA_DIR=/data PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server/server.js ./
COPY index.html manifest.json icon-192.png icon-512.png ./public/
EXPOSE 8080
CMD ["node", "server.js"]
