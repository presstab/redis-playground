# Redis Data Structure Playground

An interactive, single-file web application for visualizing Redis data structures. Execute Redis commands directly in your browser and see how they manipulate Strings, Lists, Hashes, Sets, and Sorted Sets in real-time. This tool is designed as an educational playground for learning and experimenting with Redis.

## Features

*   **Interactive Terminal:** Execute a wide range of Redis commands with history and autocomplete.
*   **Live Visualizations:** Watch data structures for Strings, Lists, Sets, Hashes, and Sorted Sets update instantly.
*   **Persistence Simulation:** Toggle and observe simulated RDB snapshots and AOF (Append-Only File) logging.
*   **Resource Monitoring:** View simulated memory usage and operations-per-second metrics.
*   **Built-in Reference:** Includes quick scenarios to populate data and a comprehensive command reference.
*   **Zero Installation:** Runs entirely in the browser. All state is saved to `localStorage`.

## How to Use

Simply download `index.html` and open it in any modern web browser. No server or installation is required.

## Supported Commands

The playground supports a large subset of common Redis commands for the following data types:

*   **Strings:** `SET`, `GET`, `MSET`, `MGET`, `DEL`
*   **Lists:** `LPUSH`, `RPUSH`, `LPOP`, `RPOP`, `LRANGE`
*   **Sets:** `SADD`, `SREM`, `SMEMBERS`, `SISMEMBER`, `SINTER`
*   **Hashes:** `HSET`, `HGET`, `HGETALL`, `HDEL`, `HKEYS`
*   **Sorted Sets:** `ZADD`, `ZREM`, `ZRANGE`, `ZCARD`
*   **Keys:** `EXPIRE`, `TTL`, `RENAME`, `TYPE`, `EXISTS`, `KEYS`, `SCAN`

Type `HELP` in the terminal for a full list.

## Tech Stack

*   **HTML5**
*   **Tailwind CSS** (via CDN)
*   **Vanilla JavaScript** (ES6+)
