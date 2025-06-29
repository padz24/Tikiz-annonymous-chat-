require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const os = require('os');
const si = require('systeminformation');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true }, // Set to true if using HTTPS
  })
);

const hybridAuth = (req, res, next) => {
  // Jika user sudah login lewat session
  if (req.session.isAuthenticated) {
    req.user = { username: req.session.adminUsername };
    return next();
  }

  // Jika pakai JWT
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      return next();
    } catch (err) {
      return res.status(403).json({ error: 'Token tidak valid' });
    }
  }

  // Kalau tidak ada session maupun token
  if (req.originalUrl.startsWith('/api')) {
    return res.status(401).json({ error: 'Token atau session tidak ditemukan' });
  } else {
    return res.redirect('/');
  }
};

// Halaman login
app.get('/', (req, res) => {
  res.render('login', { error: null });
});

app.post('/', async (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.isAuthenticated = true;
    req.session.adminUsername = username;
    res.redirect('/dashboard');
  } else {
    res.render('login', { error: 'Username atau password salah' });
  }
});

// Rute login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ username }, process.env.JWT_SECRET);
    res.json({ token, username });
  } else {
    res.status(401).json({ error: 'Username atau password salah' });
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ... (Kode sebelumnya di server.js)
app.get('/dashboard', hybridAuth, async (req, res) => {
  res.render('dashboard', { adminUsername: req.user?.username || 'Admin' });
});

app.get('/api/system-info', hybridAuth, async (req, res) => {
  try {
    const cpuLoad = await si.currentLoad();
    const mem = await si.mem();
    const networkStats = await si.networkStats();

    const cpu = {
      cores: os.cpus()?.length || "No data",
      model: os.cpus()[0]?.model || "No data",
      load: cpuLoad?.currentLoad.toFixed(2) + '%' || "No data"
    };

    const memory = {
      total: (mem.total / 1024 / 1024 / 1024).toFixed(2) + ' GB',
      used: (mem.used / 1024 / 1024 / 1024).toFixed(2) + ' GB',
      usage: ((mem.used / mem.total) * 100).toFixed(2) + '%'
    };

    const network = {
      iface: networkStats[0]?.iface || 'N/A',
      rx: (networkStats[0]?.rx_bytes / 1024 / 1024).toFixed(2) + ' MB',
      tx: (networkStats[0]?.tx_bytes / 1024 / 1024).toFixed(2) + ' MB'
    };

    res.json({ cpu, memory, network });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hapus laporan
app.post('/reports/delete/:report_id', hybridAuth, async (req, res) => {
  const { report_id } = req.params;

  const { data, error } = await supabase
    .from('reports')
    .delete()
    .eq('id', report_id)
    .select()
    .single();

  if (error || !data) {
    return res.redirect('/reports?error=Laporan tidak ditemukan');
  }

  res.redirect('/reports');
});

// Statistik
app.get('/stats', hybridAuth, async (req, res) => {
  const [
    { count: totalUsers },
    { count: activeChats },
    { count: pendingReports },
    { count: bannedUsers }
  ] = await Promise.all([
    supabase.from('users').select('*', { count: 'exact' }),
    supabase.from('chat_pairs').select('*', { count: 'exact' }),
    supabase.from('reports').select('*', { count: 'exact' }),
    supabase.from('banned_users').select('*', { count: 'exact' })
  ]);

  const stats = {
    totalUsers,
    activeChats,
    pendingReports,
    bannedUsers,
    lastUpdated: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
  };

  res.render('stats', { stats, error: null });
});

app.get('/stats/data', hybridAuth, async (req, res) => {
  try {
    const [
      { count: totalUsers },
      { count: activeChats },
      { count: pendingReports },
      { count: bannedUsers }
    ] = await Promise.all([
      supabase.from('users').select('*', { count: 'exact' }),
      supabase.from('chat_pairs').select('*', { count: 'exact' }),
      supabase.from('reports').select('*', { count: 'exact' }),
      supabase.from('banned_users').select('*', { count: 'exact' })
    ]);

    const stats = {
      totalUsers,
      activeChats,
      pendingReports,
      bannedUsers,
      lastUpdated: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
    };

    res.json({ stats, error: null });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/stats/reports-trend', hybridAuth, async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const { data, error } = await supabase
    .from('reports')
    .select('created_at')
    .gte('created_at', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
  if (error) return res.status(500).json({ error: error.message });

  const counts = {};
  data.forEach(report => {
    const date = new Date(report.created_at).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
    counts[date] = (counts[date] || 0) + 1;
  });

  const labels = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
    labels.push(date);
    if (!counts[date]) counts[date] = 0;
  }

  const values = labels.map(date => counts[date]);
  res.json({ labels, values });
});

// Daftar pengguna
app.get('/users', hybridAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10;
  const offset = (page - 1) * limit;
  const user_id = req.query.user_id || '';
  const username = req.query.username || '';

  let query = supabase
    .from('users')
    .select('user_id, username, status', { count: 'exact' })
    .range(offset, offset + limit - 1);

  if (user_id) query = query.eq('user_id', user_id);
  if (username) query = query.ilike('username', `%${username}%`);

  const { data: users, count, error } = await query;
  const { data: bannedUsers } = await supabase.from('banned_users').select('user_id');

  if (error) {
    return res.render('users', { users: [], page, totalPages: 0, user_id, username, error: error.message, adminUsername: req.session.adminUsername || 'Admin' });
  }

  const totalPages = Math.ceil(count / limit);
  const usersWithBanStatus = users.map(user => ({
    ...user,
    isBanned: bannedUsers.some(banned => banned.user_id === user.user_id)
  }));

  res.render('users', { users: usersWithBanStatus, page, totalPages, user_id, username, error: null, adminUsername: req.session.adminUsername || 'Admin' });
});

app.get('/users/data', hybridAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    const user_id = req.query.user_id || '';
    const username = req.query.username || '';

    let query = supabase
      .from('users')
      .select('user_id, username, status', { count: 'exact' })
      .range(offset, offset + limit - 1);

    if (user_id) query = query.eq('user_id', user_id);
    if (username) query = query.ilike('username', `%${username}%`);

    const { data: users, count, error } = await query;
    const { data: bannedUsers } = await supabase.from('banned_users').select('user_id');

    if (error) throw new Error(error.message);

    const usersWithBanStatus = users.map(user => ({
      ...user,
      isBanned: bannedUsers.some(banned => banned.user_id === user.user_id)
    }));

    res.json({ users: usersWithBanStatus, error: null });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Ban pengguna
app.post('/users/ban/:user_id', hybridAuth, async (req, res) => {
  const { user_id } = req.params;
  const reason = req.body.reason || 'Tidak ada alasan yang diberikan';

  const { error } = await supabase
    .from('banned_users')
    .insert({ user_id: parseInt(user_id), reason });

  if (error) {
    return res.redirect(`/users?error=Gagal memblokir pengguna: ${error.message}`);
  }

  res.redirect('/users');
});

// Hapus pengguna
app.post('/users/delete/:user_id', hybridAuth, async (req, res) => {
  const { user_id } = req.params;

  // Hapus dari banned_users
  await supabase.from('banned_users').delete().eq('user_id', user_id);
  
  // Hapus semua pesan yang dikirim user ini
  await supabase.from('messages').delete().eq('sender_id', user_id);
  
  // Hapus user
  const { data, error } = await supabase
    .from('users')
    .delete()
    .eq('user_id', user_id)
    .select()
    .single();
  
  if (error || !data) {
    return res.redirect(`/users?error=${encodeURIComponent(error?.message || 'Gagal menghapus user')}`);
  }

  res.redirect('/users');
});

// Daftar pengguna yang diblokir
app.get('/banned-users', hybridAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 5;
  const offset = (page - 1) * limit;
  const userId = req.query.user_id ? parseInt(req.query.user_id) : null;
  const startDate = req.query.start_date;
  const endDate = req.query.end_date;

  let query = supabase
    .from('banned_users')
    .select('user_id, reason, banned_at', { count: 'exact' })
    .order('banned_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (userId) {
    query = query.eq('user_id', userId);
  } else if (startDate && endDate) {
    query = query.gte('banned_at', new Date(startDate).toISOString()).lte('banned_at', new Date(endDate).toISOString());
  } else if (startDate) {
    const end = new Date(startDate);
    end.setDate(end.getDate() + 1);
    query = query.gte('banned_at', new Date(startDate).toISOString()).lt('banned_at', end.toISOString());
  }

  const { data: bannedUsers, error, count } = await query;

  if (error) {
    return res.render('banned-users', { 
      bannedUsers: [], 
      totalPages: 0, 
      page, 
      user_id: userId, 
      start_date: startDate, 
      end_date: endDate, 
      error: error.message 
    });
  }

  const totalPages = Math.ceil(count / limit);
  const users = await Promise.all(
    bannedUsers.map(async (banned) => {
      const { data: user } = await supabase
        .from('users')
        .select('username')
        .eq('user_id', banned.user_id)
        .single();
      return { ...banned, username: user?.username || 'Unknown' };
    })
  );

  res.render('banned-users', { 
    bannedUsers: users, 
    totalPages, 
    page, 
    user_id: userId, 
    start_date: startDate, 
    end_date: endDate, 
    error: null 
  });
});

// Unban pengguna
app.post('/banned-users/unban/:user_id', hybridAuth, async (req, res) => {
  const { user_id } = req.params;

  const { data, error } = await supabase
    .from('banned_users')
    .delete()
    .eq('user_id', user_id)
    .select()
    .single();

  if (error || !data) {
    return res.redirect('/banned-users?error=Pengguna tidak ditemukan');
  }

  res.redirect('/banned-users');
});

// Daftar laporan
app.get('/reports', hybridAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 5;
  const offset = (page - 1) * limit;
  const userId = req.query.user_id ? parseInt(req.query.user_id) : null;
  const startDate = req.query.start_date;
  const endDate = req.query.end_date;

  let query = supabase
    .from('reports')
    .select('id, reporter_id, reported_user_id, reason, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (userId) {
    query = query.or(`reporter_id.eq.${userId},reported_user_id.eq.${userId}`);
  } else if (startDate && endDate) {
    query = query.gte('created_at', new Date(startDate).toISOString()).lte('created_at', new Date(endDate).toISOString());
  } else if (startDate) {
    const end = new Date(startDate);
    end.setDate(end.getDate() + 1);
    query = query.gte('created_at', new Date(startDate).toISOString()).lt('created_at', end.toISOString());
  }

  const { data: reports, error, count } = await query;

  if (error) {
    return res.render('reports', { 
      reports: [], 
      totalPages: 0, 
      page, 
      user_id: userId, 
      start_date: startDate, 
      end_date: endDate, 
      error: error.message 
    });
  }

  const totalPages = Math.ceil(count / limit);
  const enrichedReports = await Promise.all(
    reports.map(async (report) => {
      const [reporter, reported] = await Promise.all([
        supabase.from('users').select('username').eq('user_id', report.reporter_id).single(),
        supabase.from('users').select('username').eq('user_id', report.reported_user_id).single(),
      ]);
      return {
        ...report,
        reporter_username: reporter.data?.username || 'Unknown',
        reported_username: reported.data?.username || 'Unknown',
      };
    })
  );

  res.render('reports', { 
    reports: enrichedReports, 
    totalPages, 
    page, 
    user_id: userId, 
    start_date: startDate, 
    end_date: endDate, 
    error: null 
  });
});

// ... (Rest of the code remains unchanged)

module.exports = app;
