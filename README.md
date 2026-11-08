# Lynx AI 🐾

موقع دردشة ذكاء اصطناعي بتصميم زجاجي، مبني على Gemini. تطوير: لحسن (Lahcen).

## المزايا
- وضع داكن / فاتح + 6 ألوان + 3 خطوط
- محادثات متعددة: إنشاء، متابعة، حذف
- حفظ المحادثات في ملفات JSON منفصلة لكل جهاز (بدون حساب)
- إرسال صور (تظهر مصغّرة) وPDF وملفات نصية
- عرض الجداول والمعادلات (KaTeX) والأكواد مع التلوين
- ردود فورية بالبث، مع زر إيقاف

## التشغيل محلياً
```bash
npm install
cp .env.example .env   # ثم ضع مفتاح Gemini داخله
npm run dev
```
افتح http://localhost:3000

## النشر على Render
1. ارفع المشروع إلى GitHub.
2. في Render: New ← Web Service ← اختر المستودع.
3. Build Command: `npm install` — Start Command: `npm start`
4. أضف متغير البيئة `GEMINI_API_KEY` (ومتغير `GEMINI_MODEL` إن أردت تغيير النموذج).

## ملاحظة عن حفظ المحادثات
الخطة المجانية في Render تمسح ملفات السيرفر عند كل إعادة نشر أو إعادة تشغيل.
لتبقى المحادثات: أضف Persistent Disk (خطة مدفوعة) واجعل `DATA_DIR` يشير لمساره، مثل `/var/data`.

## البنية
```
server.js          واجهة API والبث
lib/persona.js     تعليمات النظام (سرّية، على السيرفر فقط)
lib/gemini.js      الاتصال بـ Gemini
lib/storage.js     حفظ المحادثات لكل جهاز
public/            الواجهة (HTML / CSS / JS)
```
