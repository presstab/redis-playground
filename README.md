# Multi-DB Playground — Redis • MongoDB • Cassandra

> An interactive, browser-based simulator for learning Redis, MongoDB, and Cassandra commands.

**Live Version:** [**https://baddiesdaddy23.github.io/redis-playground/**](https://baddiesdaddy23.github.io/redis-playground/)

## 🚀 Running Locally

Because this project uses JavaScript Modules, you cannot run it by simply opening the `index.html` file from your local file system. Browsers block modules from loading this way for security reasons (CORS policy).

You **must** serve the files from a local web server or **use github pages**. Here are a few simple ways to do this:

### Option 1: Using VS Code + Live Server (Easiest)
1.  If you use Visual Studio Code, install the **[Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer)** extension.
2.  Right-click on `index.html` in the file explorer.
3.  Select **"Open with Live Server"**.

### Option 2: Using Python
If you have Python installed, you can use its built-in web server. Open your terminal in the project's root directory (the one containing `index.html`) and run:

```bash
# For Python 3.x
python -m http.server
````

Then, open `http://localhost:8000` in your browser.

### Option 3: Using Node.js

If you have Node.js installed, you can use the popular `http-server` package.

```bash
# 1. Install it globally (you only need to do this once)
npm install -g http-server

# 2. Run it in your project directory
http-server
```

Then, open the `http://localhost:8080` (or similar) URL it displays in your browser.

```
```
