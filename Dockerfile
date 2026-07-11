# Candidate Finder — production image
FROM node:22-alpine

WORKDIR /app

# Install production deps first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY src ./src
COPY public ./public
COPY data ./data

# Run as the built-in non-root user.
USER node

ENV NODE_ENV=production
# Persist settings/jobs/pool on a mounted volume in production.
ENV DATA_DIR=/var/data

EXPOSE 3000
CMD ["npm", "start"]
