# Use official Node.js runtime as parent image
FROM node:18-alpine

# Set working directory inside container
WORKDIR /app

# Copy package manifests first to leverage Docker caching
COPY package*.json ./

# Install production dependencies
RUN npm install --production

# Copy application source code
COPY . .

# Expose server port (default 3000)
EXPOSE 3000

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Command to run application
CMD ["npm", "start"]
