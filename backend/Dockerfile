FROM node:22-alpine

# poppler-utils: pdftotext for statement parsing.
# postgresql16-client: pg_dump for the nightly backup — must match the server's
# major version (postgres:16-alpine) or pg_dump refuses to run.
RUN apk add --no-cache poppler-utils postgresql16-client

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "src/index.js"]
