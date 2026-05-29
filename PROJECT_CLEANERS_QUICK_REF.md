# 🧹 Project-Specific Cleaners - Quick Reference

## What's New

Each project now has its **own dedicated cleaning service**:
- ✅ Aetna service (`aetna_cleaning.js`)
- ✅ CareFirst service (`cfmd_cleaning.js`)
- ✅ Easy to add more projects

## Why Separate Services?

| Feature | Before | After |
|---------|--------|-------|
| Schema | Shared | Project-specific |
| Statistics | Generic | Per-project tracking |
| Logic | Generic | Can customize per project |
| Processing | One endpoint | Dedicated endpoints per project |
| Scheduling | Global | Per-project scheduling |

---

## Quick Start

### Process Aetna Files

**Via API**:
```bash
# Single file
curl -X POST http://localhost:3001/api/cleaning/aetna/process \
  -H "Content-Type: application/json" \
  -d '{"filePath": "/path/to/file.xlsx"}'

# Directory
curl -X POST http://localhost:3001/api/cleaning/aetna/process \
  -H "Content-Type: application/json" \
  -d '{"directory": "/path/to/aetna_files"}'
```

**Via Code**:
```javascript
import aetnaService from './src/cleaners/aetna_cleaning.js';

const result = await aetnaService.processFile('/path/file.xlsx');
const results = await aetnaService.processDirectory('/path/dir');
```

### Process CareFirst Files

**Via API**:
```bash
# Single file
curl -X POST http://localhost:3001/api/cleaning/carefirst/process \
  -H "Content-Type: application/json" \
  -d '{"filePath": "/path/to/file.xlsx"}'

# Directory  
curl -X POST http://localhost:3001/api/cleaning/carefirst/process \
  -H "Content-Type: application/json" \
  -d '{"directory": "/path/to/carefirst_files"}'
```

**Via Code**:
```javascript
import carefirstService from './src/cleaners/cfmd_cleaning.js';

const result = await carefirstService.processFile('/path/file.xlsx');
const results = await carefirstService.processDirectory('/path/dir');
```

---

## All Endpoints

### Aetna
```
POST   /api/cleaning/aetna/process    → Process files
GET    /api/cleaning/aetna/schema     → Get schema details
GET    /api/cleaning/aetna/stats      → Get statistics
```

### CareFirst
```
POST   /api/cleaning/carefirst/process    → Process files
GET    /api/cleaning/carefirst/schema     → Get schema details
GET    /api/cleaning/carefirst/stats      → Get statistics
```

---

## Common Operations

### Get Project Schema
```bash
curl http://localhost:3001/api/cleaning/aetna/schema

# Response: { columns: {...}, requiredFields: [...], ... }
```

### Get Project Statistics
```bash
curl http://localhost:3001/api/cleaning/aetna/stats

# Response: { filesProcessed: 45, successCount: 43, ... }
```

### Reset Project Statistics
```javascript
import aetnaService from './src/cleaners/aetna_cleaning.js';
aetnaService.resetStatistics();
```

---

## Adding a New Project

**3 Steps:**

1️⃣ **Create Schema**  
Create `schemas/myproject.json`:
```json
{
  "projectName": "MyProject",
  "columns": { ... },
  "requiredFields": [ ... ]
}
```

2️⃣ **Copy Template**
```bash
cp src/cleaners/TEMPLATE_cleaning.js src/cleaners/myproject_cleaning.js
```
Then edit:
- Change `PROJECT_NAME = 'myproject'`
- Change `PROJECT_DISPLAY_NAME = 'My Project'`
- Rename class: `MyProjectCleaningService`

3️⃣ **Add API Routes**  
In `src/routes/api.js`:
```javascript
// Import
import myprojectService from '../cleaners/myproject_cleaning.js';

// Add endpoints (copy Aetna endpoints as template)
router.post('/cleaning/myproject/process', async (req, res) => { ... });
router.get('/cleaning/myproject/schema', async (req, res) => { ... });
router.get('/cleaning/myproject/stats', async (req, res) => { ... });
```

Done! ✅ Restart server and your new project cleaner is ready.

---

## File Locations

```
src/cleaners/
├── aetna_cleaning.js          ← Aetna service
├── cfmd_cleaning.js           ← CareFirst service
├── TEMPLATE_cleaning.js       ← Copy this for new projects
└── myproject_cleaning.js      ← Your new project

schemas/
├── aetna.json
├── carefirst.json
└── myproject.json             ← Add your schema
```

---

## Standard Service Methods

```javascript
// All services have these methods:

await service.processFile(filePath)           // Process one file
await service.processDirectory(dirPath)       // Process all files in folder
await service.getSchemaInfo()                 // Get schema details
service.getStatistics()                       // Get stats object
service.resetStatistics()                     // Clear stats
```

---

## Service Statistics

```javascript
{
  project: 'aetna',
  displayName: 'Aetna',
  statistics: {
    filesProcessed: 45,
    successCount: 43,
    failureCount: 2,
    totalRowsProcessed: 12845,
    startTime: Date,
    endTime: Date
  },
  successRate: '95.56%',
  averageRowsPerFile: '298'
}
```

---

## Examples

### Example 1: Process Both Projects
```bash
#!/bin/bash

echo "Aetna:"
curl -X POST http://localhost:3001/api/cleaning/aetna/process \
  -d '{"directory": "/data/aetna"}' -H "Content-Type: application/json"

echo "CareFirst:"
curl -X POST http://localhost:3001/api/cleaning/carefirst/process \
  -d '{"directory": "/data/carefirst"}' -H "Content-Type: application/json"

echo "Stats:"
curl http://localhost:3001/api/cleaning/aetna/stats | jq '.statistics'
curl http://localhost:3001/api/cleaning/carefirst/stats | jq '.statistics'
```

### Example 2: Node.js Processing
```javascript
import aetnaService from './src/cleaners/aetna_cleaning.js';
import carefirstService from './src/cleaners/cfmd_cleaning.js';

async function cleanAll() {
    console.log('Processing Aetna...');
    const aResult = await aetnaService.processDirectory('./data/aetna');
    
    console.log('Processing CareFirst...');
    const cfResult = await carefirstService.processDirectory('./data/carefirst');
    
    console.log('Aetna stats:', aetnaService.getStatistics());
    console.log('CareFirst stats:', carefirstService.getStatistics());
}

cleanAll();
```

### Example 3: Get All Schemas
```bash
#!/bin/bash

echo "Available Project Schemas:"
echo ""
echo "Aetna:"
curl -s http://localhost:3001/api/cleaning/aetna/schema | jq '.columns | keys | length'

echo "CareFirst:"
curl -s http://localhost:3001/api/cleaning/carefirst/schema | jq '.columns | keys | length'
```

---

## Architecture

```
Your Data Files
    ↓
Aetna Service ←→ Aetna Schema
     ↓              ↓
Generic DataCleaner Engine
     ↓
   ├─→ Validate
   ├─→ Transform
   ├─→ Upload to Blob
   └─→ Store Metadata
     ↓
CareFirst Service ←→ CareFirst Schema
```

---

## Benefits

✅ **Different Schemas** - Each project has unique columns  
✅ **Project Isolation** - Separate stats per project  
✅ **Easy Scaling** - Add projects without touching core  
✅ **Custom Logic** - Add project-specific methods if needed  
✅ **Independent Triggers** - Schedule each project differently  
✅ **Clear Separation** - No mixed logic between projects  

---

## Need Help?

- **Setup**: Read `PROJECT_CLEANERS.md`
- **API**: Check `API_REFERENCE.md`
- **General**: See `CLEANING_SETUP.md`

---

**Status**: ✅ Ready to Use
**Date**: March 12, 2026
