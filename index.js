require('dotenv').config();
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit'); // Untuk logika rate limiting
const crypto = require('crypto');

// Inisialisasi bot dan Supabase
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // Tambahkan ke .env
const IV_LENGTH = 16;

// Objek untuk menyimpan waktu pesan terakhir per pengguna
const messageTimestamps = new Map();

// Rate limiter: Batasi 10 pesan per menit per pengguna
const messageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 menit
  max: 10, // Maksimal 10 pesan
  keyGenerator: (ctx) => ctx.from.id.toString(),
  handler: (ctx) => {
    ctx.reply('Kamu mengirim terlalu banyak pesan! Tunggu sebentar sebelum mengirim lagi.');
  },
});

// Fungsi untuk memeriksa apakah pengguna diblokir
async function isUserBanned(userId) {
  const { data } = await supabase
    .from('banned_users')
    .select('user_id')
    .eq('user_id', userId)
    .single();
  return !!data;
}

// Fungsi untuk menambahkan atau memperbarui pengguna
async function upsertUser(userId, username) {
  const { error } = await supabase
    .from('users')
    .upsert({ user_id: userId, username, status: 'idle' }, { onConflict: 'user_id' });
  if (error) console.error('Error upserting user:', error);
}

// Fungsi untuk mencari pasangan obrolan
async function findChatPartner(userId) {
  if (await isUserBanned(userId)) {
    return null;
  }

  // Panggil fungsi SQL untuk mencari dan memasangkan pengguna
  const { data, error } = await supabase.rpc('find_and_pair_user', { current_user_id: userId });

  if (error || !data || data.length === 0) {
    console.log(`Tidak ada pengguna lain yang waiting untuk user ${userId}: ${error?.message || 'No users found'}`);
    // Set status pengguna saat ini ke 'waiting'
    await supabase
      .from('users')
      .update({ status: 'waiting', updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    return null;
  }

  const partnerId = data[0].partner_id;
  // Simpan sesi obrolan
  await supabase
    .from('chat_pairs')
    .insert({ user1_id: userId, user2_id: partnerId });

  console.log(`Partner ditemukan: ${userId} dipasangkan dengan ${partnerId}`);
  return partnerId;
}

// Fungsi untuk mendapatkan pasangan obrolan
async function getChatPartner(userId) {
  const { data: pair } = await supabase
    .from('chat_pairs')
    .select('user1_id, user2_id')
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (pair) {
    return pair.user1_id === userId ? pair.user2_id : pair.user1_id;
  }
  return null;
}

// Fungsi untuk mengakhiri obrolan
async function endChat(userId) {
  const partnerId = await getChatPartner(userId);
  if (partnerId) {
    await supabase
      .from('chat_pairs')
      .delete()
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);
    await supabase
      .from('users')
      .update({ status: 'idle' })
      .in('user_id', [userId, partnerId]);
    return partnerId;
  }
  return null;
}

// Notifikasi berkala untuk pengguna yang waiting
setInterval(async () => {
  const { data: waitingUsers } = await supabase
    .from('users')
    .select('user_id, updated_at')
    .eq('status', 'waiting');

  for (const user of waitingUsers) {
    if (new Date() - new Date(user.updated_at) > 60 * 1000) {
      bot.telegram.sendMessage(user.user_id, 'Masih mencari partner... Silakan tunggu atau gunakan /stop untuk membatalkan.');
    }
  }
}, 60 * 1000); // Setiap 1 menit

// Perintah /start
bot.command('start', async (ctx) => {
  const userId = ctx.from.id;
  if (await isUserBanned(userId)) {
    ctx.reply('Maaf, kamu telah diblokir dari bot ini.');
    return;
  }
  const username = ctx.from.username || 'Anonymous';
  await upsertUser(userId, username);
  ctx.reply('Selamat datang di Anonymous Chat! Gunakan /find untuk mencari partner obrolan.');
});

bot.command('find', async (ctx) => {
  const userId = ctx.from.id;
  if (await isUserBanned(userId)) {
    ctx.reply('Maaf, kamu telah diblokir dari bot ini.');
    return;
  }

  const { data: user } = await supabase
    .from('users')
    .select('status, updated_at')
    .eq('user_id', userId)
    .single();

  if (!user) {
    ctx.reply('Kamu belum terdaftar. Gunakan /start untuk mendaftar.');
    return;
  }

  if (user.status === 'chatting') {
    ctx.reply('Kamu sudah sedang mengobrol. Gunakan /stop untuk mengakhiri obrolan.');
    return;
  }

  if (user.status === 'waiting' && user.updated_at && (new Date() - new Date(user.updated_at)) > 5 * 60 * 1000) {
    await supabase
      .from('users')
      .update({ status: 'idle', updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    ctx.reply('Waktu tunggu habis. Mencoba mencari partner baru...');
  }

  ctx.reply('Mencari partner obrolan...');
  const partnerId = await findChatPartner(userId);

  if (partnerId) {
    ctx.reply('Partner ditemukan! Mulai mengobrol.');
    bot.telegram.sendMessage(partnerId, 'Partner ditemukan! Mulai mengobrol.');
  } else {
    ctx.reply('Menunggu partner lain bergabung...');
  }
});

// Perintah /stop
bot.command('stop', async (ctx) => {
  const userId = ctx.from.id;
  const partnerId = await endChat(userId);

  if (partnerId) {
    ctx.reply('Obrolan diakhiri. Gunakan /find untuk mencari partner baru.');
    bot.telegram.sendMessage(partnerId, 'Partner kamu mengakhiri obrolan. Gunakan /find untuk mencari partner baru.');
  } else {
    ctx.reply('Kamu tidak sedang mengobrol.');
  }
});

// Perintah /report
bot.command('report', async (ctx) => {
  const userId = ctx.from.id;
  const partnerId = await getChatPartner(userId);

  if (!partnerId) {
    ctx.reply('Kamu tidak sedang mengobrol. Gunakan /find untuk mencari partner.');
    return;
  }

  const args = ctx.message.text.split(' ').slice(1).join(' ');
  const reason = args || 'Tidak ada alasan yang diberikan';
  await supabase
    .from('reports')
    .insert({ reporter_id: userId, reported_user_id: partnerId, reason });

  ctx.reply('Laporan telah dikirim ke admin. Gunakan /stop untuk mengakhiri obrolan.');
  bot.telegram.sendMessage(
    ADMIN_ID,
    `Laporan baru:\nDari: ${userId}\nTerhadap: ${partnerId}\nAlasan: ${reason}`
  );
});

// Perintah /ban (hanya untuk admin)
// ... (Kode sebelumnya hingga bagian perintah tetap sama)

// Perintah /report (diperbarui untuk notifikasi otomatis)
bot.command('report', async (ctx) => {
  const userId = ctx.from.id;
  const partnerId = await getChatPartner(userId);

  if (!partnerId) {
    ctx.reply('Kamu tidak sedang mengobrol. Gunakan /find untuk mencari partner.');
    return;
  }

  const args = ctx.message.text.split(' ').slice(1).join(' ');
  const reason = args || 'Tidak ada alasan yang diberikan';

  const { data: report, error } = await supabase
    .from('reports')
    .insert({ reporter_id: userId, reported_user_id: partnerId, reason })
    .select()
    .single();

  if (error) {
    ctx.reply('Gagal mengirim laporan: ' + error.message);
    return;
  }

  ctx.reply('Laporan telah dikirim ke admin. Gunakan /stop untuk mengakhiri obrolan.');

  // Notifikasi otomatis ke admin
  const reporter = await supabase
    .from('users')
    .select('username')
    .eq('user_id', userId)
    .single();
  const reported = await supabase
    .from('users')
    .select('username')
    .eq('user_id', partnerId)
    .single();

  const notification = `Laporan Baru:\n` +
                      `ID Laporan: ${report.id}\n` +
                      `Dari: ${reporter.data?.username || 'Unknown'} (${userId})\n` +
                      `Terhadap: ${reported.data?.username || 'Unknown'} (${partnerId})\n` +
                      `Alasan: ${reason}\n` +
                      `Waktu: ${new Date(report.created_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`;
  bot.telegram.sendMessage(ADMIN_ID, notification);
});

// Perintah /ban (sudah ada, untuk konteks)
bot.command('ban', async (ctx) => {
  const userId = ctx.from.id;
  if (userId !== ADMIN_ID) {
    ctx.reply('Perintah ini hanya untuk admin.');
    return;
  }

  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    ctx.reply('Gunakan: /ban <user_id> [alasan]');
    return;
  }

  const targetUserId = parseInt(args[1]);
  const reason = args.slice(2).join(' ') || 'Tidak ada alasan yang diberikan';

  await supabase
    .from('banned_users')
    .insert({ user_id: targetUserId, reason });

  const partnerId = await endChat(targetUserId);
  if (partnerId) {
    bot.telegram.sendMessage(partnerId, 'Partner kamu telah diblokir. Gunakan /find untuk mencari partner baru.');
  }

  ctx.reply(`Pengguna ${targetUserId} telah diblokir. Alasan: ${reason}`);
  bot.telegram.sendMessage(targetUserId, `Kamu telah diblokir dari bot ini. Alasan: ${reason}`);
});

// Perintah /unban (sudah ada, untuk konteks)
bot.command('unban', async (ctx) => {
  const userId = ctx.from.id;
  if (userId !== ADMIN_ID) {
    ctx.reply('Perintah ini hanya untuk admin.');
    return;
  }

  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    ctx.reply('Gunakan: /unban <user_id>');
    return;
  }

  const targetUserId = parseInt(args[1]);

  const { data } = await supabase
    .from('banned_users')
    .delete()
    .eq('user_id', targetUserId)
    .select()
    .single();

  if (!data) {
    ctx.reply(`Pengguna ${targetUserId} tidak ditemukan di daftar blokir.`);
    return;
  }

  ctx.reply(`Pengguna ${targetUserId} telah dibatalkan pemblokirannya.`);
  bot.telegram.sendMessage(targetUserId, 'Pemblokiran kamu telah dicabut. Kamu bisa menggunakan bot lagi.');
});

// Perintah /viewreports (sudah ada, untuk konteks)
bot.command('viewreports', async (ctx) => {
  const userId = ctx.from.id;
  if (userId !== ADMIN_ID) {
    ctx.reply('Perintah ini hanya untuk admin.');
    return;
  }

  const args = ctx.message.text.split(' ').slice(1);
  let pageIndex = args.indexOf('page');
  const page = (pageIndex !== -1 && args[pageIndex + 1] && !isNaN(args[pageIndex + 1])) ? parseInt(args[pageIndex + 1]) : 1;
  const limit = 5; // 5 laporan per halaman
  const offset = (page - 1) * limit;

  let query = supabase
    .from('reports')
    .select('id, reporter_id, reported_user_id, reason, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (args[0] === 'user' && args[1] && !isNaN(args[1])) {
    const targetUserId = parseInt(args[1]);
    query = query.or(`reporter_id.eq.${targetUserId},reported_user_id.eq.${targetUserId}`);
  } else if (args[0] === 'date' && args[1]) {
    const date = args[1];
    const startDate = new Date(date).toISOString();
    const endDate = new Date(new Date(date).setDate(new Date(date).getDate() + 1)).toISOString();
    query = query.gte('created_at', startDate).lt('created_at', endDate);
  }

  const { data: reports, error, count } = await query;

  if (error) {
    ctx.reply('Gagal mengambil laporan: ' + error.message);
    return;
  }

  if (!reports || reports.length === 0) {
    ctx.reply('Tidak ada laporan yang ditemukan.');
    return;
  }

  const totalPages = Math.ceil(count / limit);
  let response = `Laporan Terbaru (Halaman ${page} dari ${totalPages}):\n\n`;
  for (const report of reports) {
    const reporter = await supabase
      .from('users')
      .select('username')
      .eq('user_id', report.reporter_id)
      .single();
    const reported = await supabase
      .from('users')
      .select('username')
      .eq('user_id', report.reported_user_id)
      .single();

    response += `ID Laporan: ${report.id}\n`;
    response += `Pelapor: ${reporter.data?.username || 'Unknown'} (${report.reporter_id})\n`;
    response += `Dilaporkan: ${reported.data?.username || 'Unknown'} (${report.reported_user_id})\n`;
    response += `Alasan: ${report.reason}\n`;
    response += `Waktu: ${new Date(report.created_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n`;
    response += '---\n';
  }

  response += `\nGunakan /viewreports page <nomor> untuk halaman lain.`;
  ctx.reply(response);
});

// Perintah /deletereport (sudah ada, untuk konteks)
bot.command('deletereport', async (ctx) => {
  const userId = ctx.from.id;
  if (userId !== ADMIN_ID) {
    ctx.reply('Perintah ini hanya untuk admin.');
    return;
  }

  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    ctx.reply('Gunakan: /deletereport <report_id>');
    return;
  }

  const reportId = parseInt(args[1]);

  const { data, error } = await supabase
    .from('reports')
    .delete()
    .eq('id', reportId)
    .select()
    .single();

  if (error || !data) {
    ctx.reply(`Laporan dengan ID ${reportId} tidak ditemukan.`);
    return;
  }

  ctx.reply(`Laporan dengan ID ${reportId} telah dihapus.`);
});

bot.command('stats', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    ctx.reply('Perintah ini hanya untuk admin.');
    return;
  }
  const [users, chats, reports, banned] = await Promise.all([
    supabase.from('users').select('*', { count: 'exact' }),
    supabase.from('chat_pairs').select('*', { count: 'exact' }),
    supabase.from('reports').select('*', { count: 'exact' }),
    supabase.from('banned_users').select('*', { count: 'exact' })
  ]);
  ctx.reply(
    `Statistik Bot:\n` +
    `Total Pengguna: ${users.count}\n` +
    `Obrolan Aktif: ${chats.count}\n` +
    `Laporan Tertunda: ${reports.count}\n` +
    `Pengguna Diblokir: ${banned.count}\n` +
    `Terakhir Diperbarui: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`
  );
});

// Perintah /listbanned (diperbarui dengan filter rentang tanggal)
bot.command('listbanned', async (ctx) => {
  const userId = ctx.from.id;
  if (userId !== ADMIN_ID) {
    ctx.reply('Perintah ini hanya untuk admin.');
    return;
  }

  const args = ctx.message.text.split(' ').slice(1);
  let pageIndex = args.indexOf('page');
  const page = (pageIndex !== -1 && args[pageIndex + 1] && !isNaN(args[pageIndex + 1])) ? parseInt(args[pageIndex + 1]) : 1;
  const limit = 5; // 5 pengguna per halaman
  const offset = (page - 1) * limit;

  let query = supabase
    .from('banned_users')
    .select('user_id, reason, banned_at', { count: 'exact' })
    .order('banned_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // Filter berdasarkan user_id
  if (args[0] === 'user' && args[1] && !isNaN(args[1])) {
    const targetUserId = parseInt(args[1]);
    query = query.eq('user_id', targetUserId);
  }
  // Filter berdasarkan tanggal tunggal
  else if (args[0] === 'date' && args[1] && args[2] !== 'to') {
    const date = args[1];
    const startDate = new Date(date).toISOString();
    const endDate = new Date(new Date(date).setDate(new Date(date).getDate() + 1)).toISOString();
    query = query.gte('banned_at', startDate).lt('banned_at', endDate);
  }
  // Filter berdasarkan rentang tanggal
  else if (args[0] === 'date' && args[1] && args[2] === 'to' && args[3]) {
    const startDate = new Date(args[1]).toISOString();
    const endDate = new Date(args[3]).toISOString();
    query = query.gte('banned_at', startDate).lte('banned_at', endDate);
  }

  const { data: bannedUsers, error, count } = await query;

  if (error) {
    ctx.reply('Gagal mengambil daftar pengguna yang diblokir: ' + error.message);
    return;
  }

  if (!bannedUsers || bannedUsers.length === 0) {
    ctx.reply('Tidak ada pengguna yang diblokir.');
    return;
  }

  const totalPages = Math.ceil(count / limit);
  let response = `Daftar Pengguna yang Diblokir (Halaman ${page} dari ${totalPages}):\n\n`;
  for (const banned of bannedUsers) {
    const user = await supabase
      .from('users')
      .select('username')
      .eq('user_id', banned.user_id)
      .single();

    response += `User ID: ${banned.user_id}\n`;
    response += `Username: ${user.data?.username || 'Unknown'}\n`;
    response += `Alasan: ${banned.reason}\n`;
    response += `Waktu Pemblokiran: ${new Date(banned.banned_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n`;
    response += '---\n';
  }

  response += `\nGunakan /listbanned page <nomor> untuk halaman lain, atau tambahkan filter: /listbanned user <user_id>, /listbanned date <YYYY-MM-DD>, atau /listbanned date <YYYY-MM-DD> to <YYYY-MM-DD>.`;
  ctx.reply(response);
});

// ... (Sisa kode tetap sama)

// Menangani pesan dengan rate limiting
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  if (await isUserBanned(userId)) {
    ctx.reply('Maaf, kamu telah diblokir dari bot ini.');
    return;
  }

  const now = Date.now();
  const timestamps = messageTimestamps.get(userId) || [];
  messageTimestamps.set(userId, [...timestamps.filter(t => now - t < 60 * 1000), now]);

  if (messageTimestamps.get(userId).length > 10) {
    ctx.reply('Kamu mengirim terlalu banyak pesan! Tunggu sebentar sebelum mengirim lagi.');
    return;
  }

  const partnerId = await getChatPartner(userId);
  if (partnerId) {
    await supabase
      .from('messages')
      .insert({ sender_id: userId, receiver_id: partnerId, message: ctx.message.text });
    await bot.telegram.sendMessage(partnerId, ctx.message.text);
  } else {
    ctx.reply('Kamu tidak sedang mengobrol. Gunakan /find untuk mencari partner.');
  }
});

// Jalankan bot
bot.launch().then(() => console.log('Bot berjalan...'));

// Tangani penutupan bot dengan anggun
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
