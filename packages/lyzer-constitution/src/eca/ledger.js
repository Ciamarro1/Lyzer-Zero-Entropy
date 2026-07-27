import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || '/tmp/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'constitutional_ledger.db');

let sharedDb = null;

export class ConstitutionalLedger {
  constructor(symbol = 'GLOBAL') {
    this.symbol = symbol;
    
    if (!sharedDb) {
      sharedDb = new Database(DB_PATH);
      sharedDb.pragma('journal_mode = WAL');
      
      sharedDb.prepare(`
        CREATE TABLE IF NOT EXISTS ledger_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          timestamp INTEGER,
          request JSON,
          verdict TEXT,
          reason TEXT,
          state JSON,
          tokenId TEXT
        )
      `).run();
      
      sharedDb.prepare(`
        CREATE TABLE IF NOT EXISTS edge_riding_counters (
          symbol TEXT PRIMARY KEY,
          drawdownNearMisses INTEGER,
          slippageNearMisses INTEGER
        )
      `).run();
    }
    
    this.db = sharedDb;
    
    // Initialize or load counters for this symbol
    const row = this.db.prepare('SELECT * FROM edge_riding_counters WHERE symbol = ?').get(this.symbol);
    if (row) {
      this.edgeRidingCounters = {
        drawdownNearMisses: row.drawdownNearMisses,
        slippageNearMisses: row.slippageNearMisses
      };
    } else {
      this.edgeRidingCounters = {
        drawdownNearMisses: 0,
        slippageNearMisses: 0
      };
      this.db.prepare(
        'INSERT INTO edge_riding_counters (symbol, drawdownNearMisses, slippageNearMisses) VALUES (?, ?, ?)'
      ).run(this.symbol, 0, 0);
    }
  }

  appendRecord(requestPayload, token, stateSnapshot) {
    const verdict = token.granted ? 'GRANT' : 'VETO';
    const reason = token.reason || '';
    
    this.db.prepare(`
      INSERT INTO ledger_entries (symbol, timestamp, request, verdict, reason, state, tokenId)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.symbol,
      Date.now(),
      JSON.stringify(requestPayload),
      verdict,
      reason,
      JSON.stringify(stateSnapshot),
      token.id
    );
    
    this._updateEdgeRidingMetrics(stateSnapshot, token);
  }

  _updateEdgeRidingMetrics(stateSnapshot, token) {
    if (!token.granted) {
      this.edgeRidingCounters.drawdownNearMisses = 0;
      this.edgeRidingCounters.slippageNearMisses = 0;
    } else {
      const MAX_DRAWDOWN = 0.05;
      const EDGE_THRESHOLD = 0.95;
      
      if (stateSnapshot.currentDrawdown >= (MAX_DRAWDOWN * EDGE_THRESHOLD)) {
        this.edgeRidingCounters.drawdownNearMisses++;
      } else {
        this.edgeRidingCounters.drawdownNearMisses = Math.max(0, this.edgeRidingCounters.drawdownNearMisses - 1);
      }
    }
    
    this.db.prepare(`
      UPDATE edge_riding_counters 
      SET drawdownNearMisses = ?, slippageNearMisses = ?
      WHERE symbol = ?
    `).run(
      this.edgeRidingCounters.drawdownNearMisses,
      this.edgeRidingCounters.slippageNearMisses,
      this.symbol
    );
  }

  getNearMissCount(metric) {
    return this.edgeRidingCounters[`${metric}NearMisses`] || 0;
  }
  
  exportLedger() {
    const rows = this.db.prepare('SELECT * FROM ledger_entries WHERE symbol = ?').all(this.symbol);
    return rows.map(r => ({
      timestamp: r.timestamp,
      request: JSON.parse(r.request),
      verdict: r.verdict,
      reason: r.reason,
      state: JSON.parse(r.state),
      tokenId: r.tokenId
    }));
  }
}

// Keep a default export for backward compatibility with tests
export const ledger = new ConstitutionalLedger('GLOBAL');