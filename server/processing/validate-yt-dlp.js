const fs = require('fs');
const path = require('path');
const ytdlp = require('./media-downloader');

async function validate() {
    console.log('🎯 正在验证 yt-dlp 下载通道（双通道 + cookies + 代理）...\n');

    const testUrls = [
        'https://www.douyin.com/video/7255833867374383397',
        'https://v.douyin.com/iL5i5K7',
        'https://www.bilibili.com/video/BV1nP421k7nF',
        'https://www.youtube.com/watch?v=9bZkp7q19f0'
    ];

    for (const url of testUrls) {
        console.log(`🔍 测试：${url}\n`);

        try {
            const result = await ytdlp('test-video', url, {
                cookies: 'D:/AI/沙盒/视频下载器/web/data/douyin-cookies.txt',
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                format: 'bestvideo+bestaudio[ext=mp4]'
            });

            console.log('✅ 成功');
            console.log('   标题:', result.title || result.title);
            console.log('   格式:', result.formats ? result.formats[0].format_id : 'N/A');
            console.log('   大小:', result.filesize || '未知');
        } catch (error) {
            console.log('❌ 失败:', error.message);
        }

        await new Promise(r => setTimeout(r, 1400));
    }

    console.log('\n🏁 端到端验证完成');
}

validate().catch(console.error);
