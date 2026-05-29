/**
 * Aetna Data Cleaning Module
 * ══════════════════════════════════════════════════════════════════
 * 
 * Specialized cleaning handler for Aetna project files.
 * Handles files with Aetna-specific schema and validation rules.
 * 
 * Features:
 * - Aetna schema validation (52 columns)
 * - Member ID standardization
 * - Date standardization (DOB, effective dates)
 * - Amount/currency formatting
 * - Data quality checks specific to Aetna
 * - Metadata tracking with project context
 */

import dataCleaner from '../dataCleaner.js';
import path from 'path';
import fs from 'fs';

const PROJECT_NAME = 'aetna';
const PROJECT_DISPLAY_NAME = 'Aetna';

class AetnaCleaningService {
    constructor() {
        this.projectName = PROJECT_NAME;
        this.displayName = PROJECT_DISPLAY_NAME;
        this.statistics = {
            filesProcessed: 0,
            successCount: 0,
            failureCount: 0,
            totalRowsProcessed: 0,
            startTime: null,
            endTime: null
        };
    }

    /**
     * Process a single Aetna file
     * @param {string} filePath         - Path to input file (XLSX or CSV)
     * @param {Object} [options={}]     - Processing options
     * @param {string} [options.outputMode] - 'excel' (default) or 'json'
     * @returns {Promise<Object>} Processing result with status and metadata
     */
    async processFile(filePath, options = {}) {
        console.log(`\n📋 AETNA CLEANING: Processing ${path.basename(filePath)}`);

        this.statistics.startTime = new Date();
        this.statistics.filesProcessed++;

        const outputMode = options.outputMode || process.env.CLEANING_OUTPUT_MODE || 'normalized-json';

        try {
            // Validate file exists
            if (!fs.existsSync(filePath)) {
                throw new Error(`File not found: ${filePath}`);
            }

            // Process file through main DataCleaner; build a minimal fileInfo and load buffer
            const buffer = fs.readFileSync(filePath);
            const fileInfo = {
                id: path.basename(filePath),
                name: path.basename(filePath),
                sharepointPath: `Shared Documents/${this.projectName}`
            };
            const result = await dataCleaner.processFile(fileInfo, buffer, { outputMode });

            if (result.success) {
                this.statistics.successCount++;
                this.statistics.totalRowsProcessed += result.metadata?.rowCount || 0;

                console.log(`✅ AETNA: Successfully processed ${result.metadata?.rowCount || 0} rows`);
                console.log(`📁 Uploaded: ${result.metadata?.blobPath}`);

                return {
                    success: true,
                    project: this.projectName,
                    file: path.basename(filePath),
                    outputMode,
                    rowsProcessed: result.metadata?.rowCount || 0,
                    uploadedTo: result.metadata?.blobPath,
                    tableGroups: result.groupedData || null,
                    processingTime: new Date() - this.statistics.startTime
                };
            } else {
                this.statistics.failureCount++;
                console.error(`❌ AETNA: Processing failed - ${result.error}`);

                return {
                    success: false,
                    project: this.projectName,
                    file: path.basename(filePath),
                    outputMode,
                    error: result.error,
                    processingTime: new Date() - this.statistics.startTime
                };
            }
        } catch (error) {
            this.statistics.failureCount++;
            console.error(`❌ AETNA: Error processing file:`, error.message);

            return {
                success: false,
                project: this.projectName,
                file: path.basename(filePath),
                outputMode,
                error: error.message,
                processingTime: new Date() - this.statistics.startTime
            };
        }
    }

    /**
     * Process multiple Aetna files from a directory
     * @param {string} dirPath          - Directory containing files to process
     * @param {Object} [options={}]     - Processing options passed through to processFile
     * @param {string} [options.outputMode] - 'excel' (default) or 'json'
     * @returns {Promise<Array>} Array of processing results
     */
    async processDirectory(dirPath, options = {}) {
        console.log(`\n🔄 AETNA CLEANING: Processing directory: ${dirPath}`);

        if (!fs.existsSync(dirPath)) {
            console.error(`Directory not found: ${dirPath}`);
            return [];
        }

        const results = [];
        const files = fs.readdirSync(dirPath)
            .filter(f => /\.(xlsx|xls|csv)$/i.test(f))
            .map(f => path.join(dirPath, f));

        console.log(`Found ${files.length} files to process`);

        for (const file of files) {
            const result = await this.processFile(file, options);
            results.push(result);
        }

        this.statistics.endTime = new Date();
        console.log(`\n📊 AETNA CLEANING: Completed ${files.length} files`);

        return results;
    }

    /**
     * Get project-specific schema information
     * @returns {Promise<Object>} Aetna schema details
     */
    async getSchemaInfo() {
        try {
            const schema = await dataCleaner.getProjectSchema(this.projectName);
            return {
                project: this.projectName,
                displayName: this.displayName,
                columns: Object.keys(schema?.columns || {}).length,
                requiredFields: schema?.requiredFields || [],
                dataQualityRules: schema?.dataQualityRules || [],
                schema: schema
            };
        } catch (error) {
            console.error('Failed to get schema info:', error.message);
            return { error: error.message };
        }
    }

    /**
     * Get cleaning statistics
     * @returns {Object} Project-specific statistics
     */
    getStatistics() {
        return {
            project: this.projectName,
            displayName: this.displayName,
            statistics: this.statistics,
            successRate: this.statistics.filesProcessed > 0
                ? (this.statistics.successCount / this.statistics.filesProcessed * 100).toFixed(2) + '%'
                : 'N/A',
            averageRowsPerFile: this.statistics.filesProcessed > 0
                ? (this.statistics.totalRowsProcessed / this.statistics.successCount).toFixed(0)
                : 0
        };
    }

    /**
     * Reset statistics
     */
    resetStatistics() {
        this.statistics = {
            filesProcessed: 0,
            successCount: 0,
            failureCount: 0,
            totalRowsProcessed: 0,
            startTime: null,
            endTime: null
        };
    }
}

// Export singleton instance
export const aetnaService = new AetnaCleaningService();
export default aetnaService;
