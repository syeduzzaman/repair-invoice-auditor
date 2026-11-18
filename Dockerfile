FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node cases ./cases
USER node
ENV HOST=0.0.0.0 PORT=8081
EXPOSE 8081
CMD ["node", "src/server.mjs"]
