# Use official Node.js runtime with Debian Bookworm (Python 3.11+)
FROM node:20-bookworm-slim

# Prevent debconf interactive prompts during build
ENV DEBIAN_FRONTEND=noninteractive

# Install ffmpeg, python3, curl, and latest yt-dlp binary
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Create downloads directory
RUN mkdir -p downloads

# Copy application files
COPY . .

# Expose port (Render automatically supplies PORT env variable)
EXPOSE 10000

# Start Node.js backend server
CMD ["node", "server.js"]
