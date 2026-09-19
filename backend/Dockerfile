# Multi-stage production Dockerfile for Backend API Gateway
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Production runner stage
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Install curl for healthchecks
RUN apk add --no-cache curl

# Create non-root user
USER node

COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/src ./src
COPY --chown=node:node --from=builder /app/database ./database
COPY --chown=node:node --from=builder /app/package*.json ./
COPY --chown=node:node --from=builder /app/server.js ./

# Create uploads directory
USER root
RUN mkdir -p /app/uploads/documents /app/data && chown -R node:node /app/uploads /app/data
USER node

EXPOSE 3000

HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
