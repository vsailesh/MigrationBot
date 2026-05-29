# MigrationBot: Unified Data Cleaning & Migration Documentation

## 1. Project Overview
MigrationBot is a Node.js/Express application for cleaning and migrating data files (from SharePoint) into Azure Blob Storage and SQL Server. It supports project-specific schemas, data quality rules, and automated tracking of file processing.

---

## 2. Architecture & File Structure
```
MigrationBot/
├── server.js                # Main entry point, initializes DataCleaner
├── src/
│   ├── dataCleaner.js       # Core cleaning engine
│   ├── routes/
│   │   └── api.js           # API endpoints for cleaning, stats, etc.
│   └── cleaners/            # Project-specific cleaning services
├── schemas/                 # JSON schemas for each project
│   ├── aetna.json
│   └── carefirst.json
├── frontend/
│   ├── app.js               # Dashboard UI logic
│   ├── index.html           # Dashboard HTML
│   └── style.css            # Dashboard styling
├── package.json             # Dependencies
└── .env                     # Environment variables
```

---

## 3. Core Components & Their Purpose
- **server.js**: Starts the app, loads DataCleaner, sets up monitoring.
- **src/dataCleaner.js**: Main cleaning engine (validates, cleans, uploads, tracks metadata).
- **src/routes/api.js**: REST API for status, stats, logs, project management, file retry.
- **src/cleaners/**: Dedicated logic for each project (Aetna, CareFirst, etc.).
- **schemas/**: JSON schema files defining columns, types, and rules per project.
- **frontend/**: Dashboard for monitoring, manual controls, and error review.

---

## 4. Setup & Quick Start
### Environment Variables (.env)
```
ENABLE_CLEANING_MONITORING=true
CLEANING_POLLING_INTERVAL_MINUTES=15
AZURE_STORAGE_CONNECTION_STRING=...
AZURE_CONTAINER=uhcncdata
SQL_CONNECTION_STRING=...
SHAREPOINT_SITE_URL=...
QUARANTINE_FOLDER=failed_data
RETRY_FOLDER=need_retry
MAX_RETRIES=3
```

### Minimal Setup
1. Add `.env` with required variables.
2. Add project schemas to `schemas/`.
3. `npm install`
4. `npm run dev`
5. Visit `http://localhost:3001` and use the dashboard.

---

## 5. API Reference (Key Endpoints)
- `GET  /api/cleaning/status`         – System status
- `POST /api/cleaning/scan`           – Trigger manual scan
- `GET  /api/cleaning/stats`          – Processing statistics
- `GET  /api/cleaning/failed-files`   – List failed files
- `GET  /api/cleaning/projects`       – List projects/schemas
- `GET  /api/cleaning/projects/:name/schema` – Get schema for a project
- `POST /api/cleaning/retry/:fileId`  – Retry a failed file
- `GET  /api/cleaning/logs`           – Processing logs

**Request/response examples and error codes are available in the API section of the dashboard.**

---

## 6. Dashboard Features
- **System Status**: Real-time cleaning status, last scan, files processed.
- **Project Statistics**: Per-project stats, success rates.
- **Failed Files**: Error details, missing columns, retry options.
- **Manual Controls**: Trigger scan, refresh stats.

---

## 7. Adding/Customizing Projects
1. Create a schema: `schemas/yourproject.json` (define columns, types, required fields).
2. Copy `src/cleaners/TEMPLATE_cleaning.js` to `src/cleaners/yourproject_cleaning.js` and customize.
3. Add API routes in `src/routes/api.js` for your project.
4. Restart the server.

---

## 8. Troubleshooting & Best Practices
- **Schema not found**: Ensure schema file exists and matches project name.
- **Files not uploading**: Check Azure connection string and permissions.
- **No stats**: Run a scan and check SQL connection.
- **Security**: Never commit `.env` to version control. Restrict access to quarantine folder.
- **Performance**: Adjust polling interval for high volume. Monitor SQL/Blob usage.

---

## 9. Deployment & Testing
- Review `.env` and credentials.
- Test with sample files and verify dashboard updates.
- Use the deployment checklist in this file for production readiness.

---

## 10. Support & Further Reading
- All previous documentation (setup, quickstart, API, implementation) is now consolidated here.
- For advanced troubleshooting, see error logs, SQL metadata, and dashboard error messages.

---

**Status:** Production Ready  
**Last Updated:** April 24, 2026
