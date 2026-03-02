# Use the official Node.js image.
FROM node:14

# Set the working directory in the container.
WORKDIR /usr/src/app

# Copy the package.json and package-lock.json files.
COPY package*.json ./

# Install system dependencies and application dependencies.
RUN apt-get update && apt-get install -y \
    build-essential \
    && npm ci

# Copy the rest of the application code.
COPY . .

# Expose the application port.
EXPOSE 8080

# Command to run the application.
CMD [ "npm", "start" ]