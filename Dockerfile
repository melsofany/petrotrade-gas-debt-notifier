# Updated Dockerfile

# Use the official Node.js image as the base image
FROM node:14

# Set the working directory
WORKDIR /usr/src/app

# Install system dependencies for Chrome
RUN apt-get update && \
    apt-get install -y \
    wget \
    unzip \
    fonts-liberation \
    libappindicator3-1 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-glib-1-2 \
    libgconf-2-4 \
    libnss3 \
    libxss1 \
    libxtst6 \
    x11-utils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Chrome
RUN wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
    dpkg -i google-chrome-stable_current_amd64.deb; \
    apt-get -f install -y && rm google-chrome-stable_current_amd64.deb

# Copy application files
COPY package*.json ./

# Install application dependencies
RUN npm install

# Copy the rest of the application files
COPY . .

# Expose port
EXPOSE 8080

# Start the application
CMD [ "npm", "start" ]