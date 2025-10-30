# Multi-DB Playground — Redis • MongoDB • Cassandra (V3.0)

> An interactive, browser-based simulator for learning Redis, MongoDB, and Cassandra commands. This is a complete, offline-first, zero-dependency application built with vanilla HTML, CSS, and JavaScript.

This document outlines the major evolution of the Multi-DB Playground from its original Redis-only version to the current V3.0 release.

---

## 🌟 Major Transformations (V3.0 vs. Original)

The application has undergone a complete architectural and functional overhaul:

1.  **Multi-Database Support:** Expanded from a **Redis-only** tool to a **full-fledged simulator** for **Redis**, **MongoDB**, and **Cassandra (CQL)**, each with its own command parser, execution engine, and data storage.
2.  **Modular Architecture:** Refactored from a single monolithic HTML file into **separate modules** (`.js`, `.css`) for improved maintainability and organization. The final build remains dependency-free.
3.  **Robust Persistence:** Upgraded from no persistence to a **versioned `localStorage` schema**, allowing users to retain their data across sessions for all three databases. Includes **legacy data migration** from earlier versions.
4.  **Full Data Lifecycle Management:** Added features for **exporting/importing** the entire state (or per-database state) as JSON files, **seeding** sample data, and a **hard reset** option.
5.  **Enhanced Terminal:** Upgraded the command terminal with **command history** (Up/Down arrows), **tab autocompletion**, dynamic suggestions (e.g., Mongo collections/fields), and a `CLEAR` command.
6.  **Context-Aware UI:** The UI now adapts to the selected database, hiding irrelevant controls (like Redis RDB settings when Mongo is active) and updating placeholders.
7.  **Accurate Persistence Simulation:** Implemented functional **AOF logging** (Append-Only File, per database) and configurable **RDB snapshotting** (Redis-only, based on write thresholds), replacing the non-functional originals.
8.  **Advanced Command Simulation:** Significantly expanded command support beyond basic CRUD:
    * **Redis:** Added Sorted Sets, advanced Set operations, `SCAN`, `TYPE`, `PERSIST`, and **real-time Pub/Sub** simulation (`PUBLISH`/`SUBSCRIBE`) using `BroadcastChannel`.
    * **MongoDB:** Added complex queries (`$or`, `$and`, `$in`, `$gte`, etc.), update operators (`$inc`, `$push`, `$rename`, etc.), basic **aggregation pipeline** (`$match`, `$group`), and `.limit()` chaining.
    * **Cassandra:** Added `CREATE INDEX` for **secondary indexing**, support for `IN` clauses on primary keys, and enforced `ALLOW FILTERING` for non-indexed/non-PK queries.
9.  **Interactive Visualizer:** The data overview panel is now **clickable**, allowing users to instantly run default read commands (e.g., `HGETALL`, `find`, `SELECT *`) for selected keys, collections, or tables.
10. **Onboarding & Safety:** Added a **CRUD Guide** modal with copy-paste examples for each DB, and implemented a storage **quota warning** to prevent `localStorage` issues.
11. **Modern Code Practices:** Replaced inline `onclick` handlers with modern event listeners and adopted a clean, maintainable command map pattern for execution logic. Removed external CSS dependencies (Tailwind) in favor of efficient, custom CSS.

The result is a powerful, self-contained educational tool for exploring and comparing three popular NoSQL databases directly in the browser.
