FROM node:22-alpine AS deps

WORKDIR /app/repos/jormungand
RUN apk add --no-cache python3 make g++
COPY repos/jormungand/package.json repos/jormungand/package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder

WORKDIR /app/repos/jormungand
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/repos/jormungand/node_modules ./node_modules
COPY repos/jormungand ./
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app/repos/jormungand
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV JORMUNGAND_DATA_DIR=/app/repos/jormungand/data
COPY --from=builder /app/repos/jormungand ./
VOLUME ["/app/repos/jormungand/data"]
EXPOSE 8080
CMD ["sh", "-c", "npm run start -- --port ${PORT:-8080}"]
