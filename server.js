require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

// Import S3 Upload Module (including Presigned URL helper)
const { upload, deleteFromNeonS3, getPresignedUrl } = require('./upload');

const app = express();
const PORT = process.env.PORT || 3001;

// 1. NEON POSTGRESQL CONNECTION CONFIGURATION
const pool = new Pool({
  connectionString: process.env.DB_CONNECTION_STRING,
  ssl: { rejectUnauthorized: false }
});

// Test Database Connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to Neon PostgreSQL:', err.stack);
  } else {
    console.log('Connected successfully to Neon PostgreSQL database.');
    release();
  }
});

// 2. MIDDLEWARES & PAYLOAD LIMITS
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Mobile Auth Token Middleware + Bypass Tunnel Warnings
app.use((req, res, next) => {
  res.setHeader('bypass-tunnel-reminder', 'true');
  res.setHeader('ngrok-skip-browser-warning', 'true');
  
  const token = req.headers['x-auth-token'];
  if (token) {
    try {
      req.session.user = JSON.parse(token);
    } catch (e) {}
  }
  next();
});

// Session Configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'delivery_portal_secret_key',
  resave: false,
  saveUninitialized: false
}));

// Seed Default Superadmin Account
(async () => {
  try {
    const res = await pool.query('SELECT * FROM users WHERE username = $1', ['superadmin']);
    if (res.rows.length === 0) {
      const hashedPassword = bcrypt.hashSync('superadmin', 10);
      const superadminId = crypto.randomUUID();
      await pool.query(
        'INSERT INTO users (id, username, password, role, company_id, can_close_case) VALUES ($1, $2, $3, $4, $5, $6)',
        [superadminId, 'superadmin', hashedPassword, 'SUPERADMIN', 'SYSTEM', 1]
      );
      console.log('Default Superadmin seeded successfully.');
    }
  } catch (err) {
    console.error('Error seeding default superadmin:', err);
  }
})();

// Auth Guard Middleware
function authMiddleware(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ----------------------------------------------------
// PAGE ROUTING & FALLBACKS
// ----------------------------------------------------

// Serve login page as the main landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Explicit route for /login
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Explicit route for /cases
app.get('/cases', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cases.html'));
});

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];

    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    req.session.user = { 
      id: user.id, 
      username: user.username, 
      role: user.role, 
      company_id: user.company_id,
      can_close_case: user.can_close_case 
    };

    res.json({ user: req.session.user });
  } catch (err) {
    res.status(500).json({ error: 'Database query failed' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Current User Session
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  res.json(req.session.user);
});

// Dashboard Analytics API (Safeguarded against empty date strings)
app.get('/api/dashboard/stats', authMiddleware, async (req, res) => {
  const currentUser = req.session.user;
  const startDate = req.query.start_date;
  const endDate = req.query.end_date;

  try {
    let whereClauses = [];
    let params = [];
    let paramIndex = 1;

    // Company Scoping for non-SUPERADMINs
    if (currentUser.role !== 'SUPERADMIN') {
      whereClauses.push(`company_id = $${paramIndex++}`);
      params.push(currentUser.company_id);
    }

    // Strict Date Validation Guard
    if (startDate && endDate && startDate.trim() !== '' && endDate.trim() !== '' && startDate !== 'undefined' && endDate !== 'undefined') {
      const startIso = new Date(startDate + 'T00:00:00.000Z');
      const endIso = new Date(endDate + 'T23:59:59.999Z');
      
      if (!isNaN(startIso.getTime()) && !isNaN(endIso.getTime())) {
        whereClauses.push(`created_at BETWEEN $${paramIndex++} AND $${paramIndex++}`);
        params.push(startIso, endIso);
      }
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // 1. KPI Aggregation
    const kpiSql = `
      SELECT 
        COUNT(*) AS total_registered,
        COUNT(*) FILTER (WHERE status = 'OPEN') AS total_open,
        COUNT(*) FILTER (WHERE status = 'CLOSED') AS total_closed,
        COUNT(*) FILTER (WHERE status = 'CLOSED' AND is_delivered = TRUE) AS total_delivered,
        COUNT(*) FILTER (WHERE status = 'CLOSED' AND is_delivered = FALSE) AS total_undelivered
      FROM cases
      ${whereClause}
    `;
    const kpiRes = await pool.query(kpiSql, params);
    const kpi = kpiRes.rows[0] || {};

    // 2. User Breakdown
    const userSql = `
      SELECT COALESCE(assigned_to, 'Unassigned') AS username, COUNT(*) AS count
      FROM cases
      ${whereClause}
      GROUP BY COALESCE(assigned_to, 'Unassigned')
      ORDER BY count DESC
    `;
    const userRes = await pool.query(userSql, params);

    // 3. Daily Velocity Trend
    const trendSql = `
      SELECT 
        TO_CHAR(created_at, 'YYYY-MM-DD') AS date_label,
        COUNT(*) AS registered_count,
        COUNT(*) FILTER (WHERE status = 'CLOSED') AS closed_count
      FROM cases
      ${whereClause}
      GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD')
      ORDER BY date_label ASC
    `;
    const trendRes = await pool.query(trendSql, params);

    res.json({
      kpi: {
        total_registered: parseInt(kpi.total_registered) || 0,
        total_open: parseInt(kpi.total_open) || 0,
        total_closed: parseInt(kpi.total_closed) || 0,
        total_delivered: parseInt(kpi.total_delivered) || 0,
        total_undelivered: parseInt(kpi.total_undelivered) || 0
      },
      userBreakdown: userRes.rows || [],
      dailyTrend: trendRes.rows || []
    });
  } catch (err) {
    console.error('Error fetching dashboard stats:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard metrics' });
  }
});

// Create Company & Admin
app.post('/api/superadmin/companies', authMiddleware, async (req, res) => {
  if (req.session.user.role !== 'SUPERADMIN') return res.status(403).json({ error: 'Forbidden' });
  const { company_name, admin_username, admin_password } = req.body;

  try {
    const existingCompany = await pool.query('SELECT * FROM companies WHERE name = $1', [company_name]);
    if (existingCompany.rows.length > 0) return res.status(400).json({ error: 'Company already exists' });

    const existingUser = await pool.query('SELECT * FROM users WHERE username = $1', [admin_username]);
    if (existingUser.rows.length > 0) return res.status(400).json({ error: 'Admin username already exists' });

    const companyId = crypto.randomUUID();
    const adminId = crypto.randomUUID();
    const hashedPassword = bcrypt.hashSync(admin_password, 10);

    await pool.query('INSERT INTO companies (id, name, created_at) VALUES ($1, $2, $3)', [companyId, company_name, new Date()]);
    await pool.query(
      'INSERT INTO users (id, username, password, role, company_id, can_close_case) VALUES ($1, $2, $3, $4, $5, $6)',
      [adminId, admin_username, hashedPassword, 'ADMIN', companyId, 1]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create company' });
  }
});

// Get Companies
app.get('/api/superadmin/companies', authMiddleware, async (req, res) => {
  if (req.session.user.role !== 'SUPERADMIN') return res.status(403).json({ error: 'Forbidden' });
  try {
    const result = await pool.query('SELECT * FROM companies ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// Delete Company & Associated S3 Media
app.delete('/api/superadmin/companies/:id', authMiddleware, async (req, res) => {
  if (req.session.user.role !== 'SUPERADMIN') return res.status(403).json({ error: 'Forbidden' });
  const companyId = req.params.id;

  try {
    const mediaResult = await pool.query(
      'SELECT t.file_path FROM timeline t JOIN cases c ON t.case_id = c.id WHERE c.company_id = $1 AND t.file_path IS NOT NULL AND t.file_path != \'\'',
      [companyId]
    );

    for (const row of mediaResult.rows) {
      if (row.file_path) await deleteFromNeonS3(row.file_path);
    }

    await pool.query('DELETE FROM timeline WHERE case_id IN (SELECT id FROM cases WHERE company_id = $1)', [companyId]);
    await pool.query('DELETE FROM cases WHERE company_id = $1', [companyId]);
    await pool.query('DELETE FROM users WHERE company_id = $1', [companyId]);
    await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete company' });
  }
});

// Create Staff User
app.post('/api/admin/users', authMiddleware, async (req, res) => {
  const currentUser = req.session.user;
  if (currentUser.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden' });

  const { username, password, can_close_case } = req.body;

  try {
    const existing = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Username already exists' });

    const userId = crypto.randomUUID();
    const hashedPassword = bcrypt.hashSync(password, 10);

    await pool.query(
      'INSERT INTO users (id, username, password, role, company_id, can_close_case) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, username, hashedPassword, 'USER', currentUser.company_id, can_close_case ? 1 : 0]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Get Staff Users
app.get('/api/users', authMiddleware, async (req, res) => {
  const currentUser = req.session.user;
  try {
    let query = 'SELECT id, username, role, company_id, can_close_case FROM users';
    let params = [];

    if (currentUser.role !== 'SUPERADMIN') {
      query += ' WHERE company_id = $1';
      params.push(currentUser.company_id);
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Delete User
app.delete('/api/users/:id', authMiddleware, async (req, res) => {
  const currentUser = req.session.user;
  const targetId = req.params.id;

  try {
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [targetId]);
    const targetUser = userResult.rows[0];

    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    if (targetUser.role === 'SUPERADMIN') return res.status(403).json({ error: 'Cannot delete Superadmin' });

    if (currentUser.role === 'SUPERADMIN' || (currentUser.role === 'ADMIN' && currentUser.company_id === targetUser.company_id)) {
      await pool.query('DELETE FROM users WHERE id = $1', [targetId]);
      return res.json({ success: true });
    }

    res.status(403).json({ error: 'Permission denied' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Register New Case
app.post('/api/cases', authMiddleware, async (req, res) => {
  const { cn_number, ref_number, mobile_number, assigned_to } = req.body;
  const currentUser = req.session.user;

  if (!cn_number || !cn_number.trim()) {
    return res.status(400).json({ error: 'CN Number is required' });
  }

  const cleanCn = cn_number.trim();
  const cleanRef = ref_number ? ref_number.trim() : '';

  try {
    const existingCn = await pool.query('SELECT * FROM cases WHERE cn_number = $1 AND company_id = $2', [cleanCn, currentUser.company_id]);
    if (existingCn.rows.length > 0) {
      return res.status(400).json({ error: `CN Number '${cleanCn}' already exists in your company.` });
    }

    if (cleanRef !== '') {
      const existingRef = await pool.query('SELECT * FROM cases WHERE ref_number = $1 AND company_id = $2', [cleanRef, currentUser.company_id]);
      if (existingRef.rows.length > 0) {
        return res.status(400).json({ error: `Ref Number '${cleanRef}' already exists in your company.` });
      }
    }

    const caseId = crypto.randomUUID();
    await pool.query(
      'INSERT INTO cases (id, cn_number, ref_number, mobile_number, status, assigned_to, company_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [caseId, cleanCn, cleanRef, mobile_number ? mobile_number.trim() : '', 'OPEN', assigned_to || 'Unassigned', currentUser.company_id, new Date()]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to register case' });
  }
});

// Get Cases
app.get('/api/cases', authMiddleware, async (req, res) => {
  const currentUser = req.session.user;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 100;
  const search = req.query.search ? req.query.search.trim() : '';
  const status = req.query.status ? req.query.status.trim().toUpperCase() : 'OPEN';
  const assignedTo = req.query.assigned_to ? req.query.assigned_to.trim() : '';

  try {
    let whereClauses = [];
    let queryParams = [];
    let paramIndex = 1;

    if (currentUser.role !== 'SUPERADMIN') {
      whereClauses.push(`c.company_id = $${paramIndex++}`);
      queryParams.push(currentUser.company_id);
    }

    if (status && status !== 'ALL') {
      whereClauses.push(`c.status = $${paramIndex++}`);
      queryParams.push(status);
    }

    if (assignedTo && assignedTo !== 'ALL') {
      whereClauses.push(`c.assigned_to = $${paramIndex++}`);
      queryParams.push(assignedTo);
    }

    if (search) {
      whereClauses.push(`(c.cn_number ILIKE $${paramIndex} OR c.ref_number ILIKE $${paramIndex})`);
      queryParams.push(`%${search}%`);
      paramIndex++;
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*) FROM cases c ${whereSql}`;
    const countResult = await pool.query(countSql, queryParams);
    const total = parseInt(countResult.rows[0].count);

    const skip = (page - 1) * limit;
    const casesSql = `
      SELECT c.*, COALESCE(comp.name, 'System') AS company_name 
      FROM cases c 
      LEFT JOIN companies comp ON c.company_id = comp.id 
      ${whereSql} 
      ORDER BY c.created_at DESC 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    const finalParams = [...queryParams, limit, skip];
    const casesResult = await pool.query(casesSql, finalParams);

    const mappedCases = casesResult.rows.map(row => ({
      ...row,
      _id: row.id
    }));

    res.json({
      cases: mappedCases,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1
    });
  } catch (err) {
    console.error('Error fetching cases:', err);
    res.status(500).json({ error: 'Failed to fetch cases' });
  }
});

// Delete Case & S3 Media
app.delete('/api/cases/:id', authMiddleware, async (req, res) => {
  const currentUser = req.session.user;
  const caseId = req.params.id;

  try {
    const caseResult = await pool.query('SELECT * FROM cases WHERE id = $1', [caseId]);
    const targetCase = caseResult.rows[0];

    if (!targetCase) return res.status(404).json({ error: 'Case not found' });

    if (currentUser.role !== 'SUPERADMIN' && (currentUser.role !== 'ADMIN' || currentUser.company_id !== targetCase.company_id)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const timelinesResult = await pool.query('SELECT file_path FROM timeline WHERE case_id = $1 AND file_path IS NOT NULL AND file_path != \'\'', [caseId]);
    for (const t of timelinesResult.rows) {
      if (t.file_path) await deleteFromNeonS3(t.file_path);
    }

    await pool.query('DELETE FROM timeline WHERE case_id = $1', [caseId]);
    await pool.query('DELETE FROM cases WHERE id = $1', [caseId]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete case' });
  }
});

// Get Timeline (Converts S3 paths to authorized presigned URLs on the fly)
app.get('/api/cases/:id/timeline', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM timeline WHERE case_id = $1 ORDER BY created_at DESC', [req.params.id]);
    
    const mappedTimeline = await Promise.all(result.rows.map(async row => {
      let signedPath = row.file_path;
      if (row.file_path) {
        signedPath = await getPresignedUrl(row.file_path);
      }
      return {
        ...row,
        _id: row.id,
        file_path: signedPath
      };
    }));

    res.json(mappedTimeline);
  } catch (err) {
    console.error('Error fetching timeline:', err);
    res.status(500).json({ error: 'Failed to fetch timeline' });
  }
});

// Post Timeline Entry
app.post('/api/cases/:id/timeline', authMiddleware, upload.single('file'), async (req, res) => {
  const { message, assigned_to } = req.body;
  const caseId = req.params.id;
  const currentUser = req.session.user;

  try {
    const caseResult = await pool.query('SELECT * FROM cases WHERE id = $1', [caseId]);
    const currentCase = caseResult.rows[0];

    if (!currentCase) return res.status(404).json({ error: 'Case not found' });

    if (currentUser.role !== 'SUPERADMIN' && currentCase.company_id !== currentUser.company_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    let systemMsg = message || '';

    if (assigned_to && assigned_to !== currentCase.assigned_to) {
      await pool.query('UPDATE cases SET assigned_to = $1 WHERE id = $2', [assigned_to, caseId]);
      const assignLog = `[System: Reassigned case from ${currentCase.assigned_to || 'Unassigned'} to ${assigned_to}]`;
      systemMsg = systemMsg ? `${systemMsg}\n${assignLog}` : assignLog;
    }

    const filePath = req.file ? req.file.location : '';
    const fileType = req.file ? req.file.mimetype : '';
    const timelineId = crypto.randomUUID();

    await pool.query(
      'INSERT INTO timeline (id, case_id, username, message, file_path, file_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [timelineId, caseId, currentUser.username, systemMsg, filePath, fileType, new Date()]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Error posting timeline update:', err);
    res.status(500).json({ error: 'Failed to post update' });
  }
});

// Toggle Case Status (Mark Delivered/Undelivered or Re-open)
app.patch('/api/cases/:id/status', authMiddleware, async (req, res) => {
  const user = req.session.user;
  
  // Permission Guard
  if (!user.can_close_case && user.role !== 'ADMIN' && user.role !== 'SUPERADMIN') {
    return res.status(403).json({ error: 'Permission denied' });
  }

  const { status, is_delivered } = req.body; // status: 'CLOSED' or 'OPEN', is_delivered: true | false | null

  try {
    if (status === 'OPEN') {
      await pool.query(
        'UPDATE cases SET status = $1, is_delivered = NULL WHERE id = $2',
        ['OPEN', req.params.id]
      );
    } else {
      await pool.query(
        'UPDATE cases SET status = $1, is_delivered = $2 WHERE id = $3',
        ['CLOSED', is_delivered === true, req.params.id]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error updating case status:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});


// Add these explicit page routes to server.js before app.listen(...)

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/cases', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cases.html'));
});

app.get('/timeline', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'timeline.html'));
});

app.get('/users', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'users.html'));
});

app.get('/companies', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'companies.html'));
});




app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});