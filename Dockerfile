# Stage 1: Build Stage
FROM node:26-alpine AS builder

RUN apk update && apk add --no-cache dumb-init

# Set working directory
WORKDIR /app

# Node.js images from version 25 do not contain Yarn. The lockfile is a Yarn 1 file.
RUN npm install --global --no-fund --no-audit yarn@1.22.22

# Install dependencies
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && \
     yarn cache clean

# Copy source code
COPY . .

# Stage 2: Production Stage
FROM node:26-alpine

# Set working directory
WORKDIR /app

# Create a non-root user and group
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy only necessary files and node_modules from the builder stage with ownership set to appuser
COPY --from=builder /usr/bin/dumb-init /usr/bin/dumb-init
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/package.json /app/yarn.lock ./
COPY --from=builder --chown=appuser:appgroup /app/src ./src
COPY --from=builder --chown=appuser:appgroup /app/.env.example ./.env

# Switch to the non-root user
USER appuser

# Define environment variables (can be overridden at runtime)
ENV NODE_ENV=production

# Healthy only while the alarm panel sends data (see src/healthcheck.mjs)
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["node", "src/healthcheck.mjs"]

# Start the application
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "src/index.mjs"]