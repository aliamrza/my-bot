/**
 * ربات قرعه‌کشی اینستاگرام - نسخه Railway
 * با پشتیبانی از pagination (همه کامنت‌ها)
 */

const BOT_TOKEN  = process.env.BOT_TOKEN;
const SESSION_ID = process.env.SESSION_ID || "";
const PORT       = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN تنظیم نشده!");
  process.exit(1);
}

const https = require("https");
const http  = require("http");

// ========================
//  HTTP Helper
// ========================
function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        path    : parsed.pathname + parsed.search,
        method  : options.method || "GET",
        headers : options.headers || {},
      },
      (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers["location"];
          if (location) return request(location, options, body).then(resolve).catch(reject);
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );

    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

// ========================
//  Telegram Helpers
// ========================
async function telegramRequest(method, body = {}) {
  const res = await request(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    body
  );
  return res.body;
}

async function sendMessage(chatId, text) {
  return telegramRequest("sendMessage", {
    chat_id   : chatId,
    text,
    parse_mode: "HTML",
  });
}

async function editMessage(chatId, messageId, text) {
  return telegramRequest("editMessageText", {
    chat_id   : chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
  });
}

// ========================
//  Instagram Helpers
// ========================
function extractShortcode(url) {
  const match = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

function instagramHeaders() {
  const cookie = SESSION_ID
    ? `sessionid=${SESSION_ID}; ig_did=1; csrftoken=missing`
    : "";

  return {
    "User-Agent"      : "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Accept"          : "application/json, text/plain, */*",
    "Accept-Language" : "en-US,en;q=0.9",
    "Accept-Encoding" : "identity",
    "Referer"         : "https://www.instagram.com/",
    "Origin"          : "https://www.instagram.com",
    "X-IG-App-ID"     : "936619743392459",
    "X-Requested-With": "XMLHttpRequest",
    "Cookie"          : cookie,
  };
}

function shortcodeToId(shortcode) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let id = BigInt(0);
  for (const char of shortcode) {
    id = id * BigInt(64) + BigInt(alphabet.indexOf(char));
  }
  return id.toString();
}

// تاخیر بین درخواست‌ها تا اینستاگرام block نکند
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * همه کامنت‌ها را با pagination می‌گیرد
 * هر صفحه ~20 کامنت - تا 100 صفحه (2000 کامنت)
 */
async function fetchAllComments(shortcode, onProgress) {
  const mediaId  = shortcodeToId(shortcode);
  const allComments = [];
  let minId      = null; // cursor برای pagination
  let page       = 0;
  const MAX_PAGES = 100; // حداکثر 100 صفحه = ~2000 کامنت

  while (page < MAX_PAGES) {
    page++;

    let url = `https://www.instagram.com/api/v1/media/${mediaId}/comments/?can_support_threading=true&permalink_enabled=false`;
    if (minId) url += `&min_id=${minId}`;

    console.log(`صفحه ${page} - cursor: ${minId}`);

    const res = await request(url, { headers: instagramHeaders() });

    console.log(`صفحه ${page} - status: ${res.status}`);

    if (res.status !== 200) {
      if (page === 1) {
        throw new Error(`اینستاگرام پاسخ نداد (${res.status}). SESSION_ID را بررسی کنید.`);
      }
      // اگر صفحات بعدی خطا داشت، با همان تعداد ادامه می‌دهیم
      console.log("توقف pagination به دلیل خطا");
      break;
    }

    const body = res.body;
    const comments = body?.comments ?? [];

    if (comments.length === 0) break;

    for (const c of comments) {
      allComments.push({
        username: c.user?.username ?? "ناشناس",
        text    : c.text,
      });
    }

    // اطلاع‌رسانی پیشرفت
    if (onProgress) await onProgress(allComments.length);

    // بررسی اینکه صفحه بعدی وجود دارد
    const hasMoreComments = body?.has_more_comments ?? false;
    const nextMinId       = body?.next_min_id ?? body?.next_max_id ?? null;

    console.log(`has_more: ${hasMoreComments}, next_id: ${nextMinId}, total: ${allComments.length}`);

    if (!hasMoreComments || !nextMinId) break;

    minId = nextMinId;

    // تاخیر 1 ثانیه بین صفحات
    await sleep(1000);
  }

  return allComments;
}

function filterByKeyword(comments, keyword) {
  const kw = keyword.trim().toLowerCase();
  return comments.filter((c) => c.text.toLowerCase().includes(kw));
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ========================
//  Session Management
// ========================
const sessions = {};

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const text   = (msg.text ?? "").trim();

  if (text === "/start") {
    sessions[chatId] = { state: "WAIT_LINK" };
    return sendMessage(
      chatId,
      "👋 سلام! به ربات قرعه‌کشی اینستاگرام خوش آمدید.\n\n" +
      "🔗 لینک پست اینستاگرام را بفرستید:"
    );
  }

  if (!sessions[chatId]) {
    sessions[chatId] = { state: "WAIT_LINK" };
    return sendMessage(chatId, "لینک پست اینستاگرام را بفرستید:");
  }

  const session = sessions[chatId];

  if (session.state === "WAIT_LINK") {
    const shortcode = extractShortcode(text);
    if (!shortcode) {
      return sendMessage(
        chatId,
        "❌ لینک معتبر نیست.\n" +
        "مثال: https://www.instagram.com/p/ABC123/\n\nدوباره بفرستید:"
      );
    }
    session.shortcode = shortcode;
    session.state     = "WAIT_KEYWORD";
    return sendMessage(
      chatId,
      "✅ لینک دریافت شد!\n\n" +
      "🔑 کلمه‌ای که می‌خواهید قرعه‌کشی روی آن انجام شود را بنویسید:\n" +
      "(مثلاً: <code>شرکت</code>)"
    );
  }

  if (session.state === "WAIT_KEYWORD") {
    const keyword = text;
    session.state = "PROCESSING";

    // پیام اولیه که آپدیت می‌شود
    const progressMsg = await sendMessage(
      chatId,
      "⏳ در حال دریافت کامنت‌ها...\n📥 <b>0</b> کامنت دریافت شد"
    );
    const progressMsgId = progressMsg?.result?.message_id;

    let lastReported = 0;

    async function onProgress(count) {
      // هر 50 کامنت یک بار پیام را آپدیت کن
      if (count - lastReported >= 50 && progressMsgId) {
        lastReported = count;
        await editMessage(
          chatId,
          progressMsgId,
          `⏳ در حال دریافت کامنت‌ها...\n📥 <b>${count}</b> کامنت دریافت شد`
        ).catch(() => {});
      }
    }

    let comments;
    try {
      comments = await fetchAllComments(session.shortcode, onProgress);
    } catch (err) {
      console.error("خطای اینستاگرام:", err.message);
      sessions[chatId] = { state: "WAIT_LINK" };
      return sendMessage(
        chatId,
        "❌ <b>خطا در دریافت کامنت‌ها:</b>\n" +
        `<code>${err.message}</code>\n\n` +
        "لینک جدید بفرستید:"
      );
    }

    if (!comments.length) {
      sessions[chatId] = { state: "WAIT_LINK" };
      return sendMessage(chatId, "😕 کامنتی پیدا نشد.\n\nلینک جدید بفرستید:");
    }

    const matched = filterByKeyword(comments, keyword);

    if (!matched.length) {
      sessions[chatId] = { state: "WAIT_LINK" };
      return sendMessage(
        chatId,
        `😕 کامنتی با کلمه "<b>${keyword}</b>" پیدا نشد.\n` +
        `(از ${comments.length} کامنت بررسی شد)\n\nلینک جدید بفرستید:`
      );
    }

    const winner = pickRandom(matched);
    sessions[chatId] = { state: "WAIT_LINK" };

    return sendMessage(
      chatId,
      `🎉 <b>قرعه‌کشی انجام شد!</b>\n\n` +
      `📊 کل کامنت‌های دریافتی: <b>${comments.length}</b>\n` +
      `✅ واجد شرایط: <b>${matched.length}</b>\n\n` +
      `🏆 <b>برنده:</b>\n` +
      `👤 <code>@${winner.username}</code>\n` +
      `💬 <i>${winner.text}</i>\n\n` +
      "برای قرعه‌کشی جدید لینک بفرستید:"
    );
  }

  if (session.state === "PROCESSING") {
    return sendMessage(chatId, "⏳ صبر کنید، در حال دریافت کامنت‌ها هستیم...");
  }
}

// ========================
//  Polling Loop
// ========================
let lastUpdateId = 0;

async function poll() {
  try {
    const data = await telegramRequest("getUpdates", {
      offset         : lastUpdateId + 1,
      timeout        : 30,
      allowed_updates: ["message"],
    });

    if (data.ok && data.result?.length > 0) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        if (update.message) {
          handleMessage(update.message).catch((e) =>
            console.error("خطا:", e.message)
          );
        }
      }
    }
  } catch (err) {
    console.error("خطای polling:", err.message);
  }

  setTimeout(poll, 2000);
}

// ========================
//  HTTP Server
// ========================
http
  .createServer((req, res) => {
    res.writeHead(200);
    res.end("ربات قرعه‌کشی فعال است ✅");
  })
  .listen(PORT, () => {
    console.log(`🌐 HTTP server روی پورت ${PORT}`);
    console.log("🤖 ربات شروع به کار کرد...");
    poll();
  });
