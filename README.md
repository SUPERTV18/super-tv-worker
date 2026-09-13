# SUPER TV — GitHub + Cloudflare Worker

تم تحويل مسارات Vercel إلى Worker واحد مع الحفاظ على API القديم:
`/api/play.m3u8`, `/api/channels`, `/api/viewers`, `/api/playlist.m3u`, `/api/proxy.m3u8`, `/api/ts`, `/admin`.

## الإعداد
1. أنشئ KV Namespace في Cloudflare.
2. ضع الـ namespace ID في `wrangler.jsonc`.
3. اربط GitHub بالمشروع عبر Workers Builds، أو استخدم `npm install` ثم `npx wrangler deploy`.
4. اختياريًا أنشئ Secret باسم `ADMIN_KEY` لحماية حفظ القنوات من لوحة التحكم.

بعد الحفظ من لوحة الإدارة تصبح بيانات القنوات في KV؛ والملف `data/channels.json` يبقى نسخة افتراضية داخل GitHub.
