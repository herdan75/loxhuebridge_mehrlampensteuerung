# loxHueBridge Mehrlampensteuerung
# Node.js 24 wird benötigt, da das Projekt das native node:sqlite Modul verwendet.
FROM node:24-alpine

WORKDIR /app

# Nur package-Dateien zuerst kopieren, damit Docker den Dependency-Layer cachen kann.
COPY package*.json ./

# Produktions-Abhängigkeiten installieren.
RUN npm ci --omit=dev

# Nur Anwendungscode kopieren; Laufzeitdaten bleiben im eingebundenen DATA_DIR.
COPY lib/ ./lib/
COPY public/ ./public/
COPY server.js ./

EXPOSE 8555

CMD ["node", "server.js"]
