const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'cards.json');

app.use(cors());
app.use(express.json());
// 禁止缓存，确保每次加载最新版本
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});
app.use(express.static(path.join(__dirname, 'public')));

// 管理员账号
const ADMIN = {
    username: '1243685477',
    password: '197422'
};

// 卡密类型配置
const CARD_TYPES = {
    hour: { duration: 3600000, name: '1小时体验卡', prefix: 'TRY' },
    week: { duration: 604800000, name: '周卡（7天）', prefix: 'WEEK' },
    month: { duration: 2592000000, name: '月卡（30天）', prefix: 'MONTH' },
    forever: { duration: Infinity, name: '永久卡', prefix: 'FOREVER' }
};

// 数据读写
function readData() {
    try {
        // 确保 data 目录存在（云端部署时自动创建）
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        if (!fs.existsSync(DATA_FILE)) {
            const initData = { cards: [], adminTokens: [] };
            fs.writeFileSync(DATA_FILE, JSON.stringify(initData, null, 2));
            return initData;
        }
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        return { cards: [], adminTokens: [] };
    }
}

function writeData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// 生成随机字符串
function genRandomStr(len) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

// 生成Token
function genToken() {
    return 'admin_' + Date.now() + '_' + genRandomStr(16);
}

// 验证管理员Token
function verifyAdminToken(token) {
    const data = readData();
    return data.adminTokens.includes(token);
}

// 管理员登录
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN.username && password === ADMIN.password) {
        const data = readData();
        const token = genToken();
        data.adminTokens.push(token);
        writeData(data);
        res.json({ success: true, token });
    } else {
        res.json({ success: false, message: '账号或密码错误' });
    }
});

// 管理员登出
app.post('/api/admin/logout', (req, res) => {
    const { token } = req.body;
    const data = readData();
    data.adminTokens = data.adminTokens.filter(t => t !== token);
    writeData(data);
    res.json({ success: true });
});

// 生成卡密
app.post('/api/cards/generate', (req, res) => {
    const { token, type, count } = req.body;
    if (!verifyAdminToken(token)) {
        return res.json({ success: false, message: '管理员未登录' });
    }
    const typeInfo = CARD_TYPES[type];
    if (!typeInfo) {
        return res.json({ success: false, message: '无效的卡密类型' });
    }
    const num = Math.min(Math.max(parseInt(count) || 1, 1), 100);
    const data = readData();
    const newCards = [];
    for (let i = 0; i < num; i++) {
        let key;
        do {
            key = typeInfo.prefix + '-' + genRandomStr(6);
        } while (data.cards.find(c => c.key === key));
        newCards.push({
            key,
            type,
            duration: typeInfo.duration,
            name: typeInfo.name,
            createTime: Date.now(),
            used: false,
            usedTime: null,
            expireTime: null,
            deviceId: null,
            deviceInfo: null
        });
    }
    data.cards = [...newCards, ...data.cards];
    writeData(data);
    res.json({ success: true, cards: newCards, count: num });
});

// 激活卡密（绑定设备）
app.post('/api/cards/activate', (req, res) => {
    const { key, deviceId, deviceInfo } = req.body;
    if (!key || !deviceId) {
        return res.json({ success: false, message: '参数不完整' });
    }
    const data = readData();
    const card = data.cards.find(c => c.key === key.toUpperCase());
    if (!card) {
        return res.json({ success: false, message: '卡密无效，请检查后重试' });
    }
    // 检查是否过期
    if (card.used && card.expireTime && Date.now() >= card.expireTime) {
        return res.json({ success: false, message: '该卡密已过期' });
    }
    // 检查是否已使用
    if (card.used) {
        if (card.deviceId === deviceId) {
            return res.json({ success: false, message: '该卡密已在本设备激活，可直接使用', alreadyActive: true });
        } else {
            return res.json({ success: false, message: '该卡密已被其他电脑激活，无法使用' });
        }
    }
    // 激活卡密，绑定设备
    card.used = true;
    card.usedTime = Date.now();
    card.deviceId = deviceId;
    card.deviceInfo = deviceInfo || '';
    if (card.duration !== Infinity) {
        card.expireTime = Date.now() + card.duration;
    }
    writeData(data);
    res.json({
        success: true,
        message: `激活成功！${card.name}（已绑定本电脑）`,
        card: {
            key: card.key,
            name: card.name,
            type: card.type,
            expireTime: card.expireTime,
            duration: card.duration
        }
    });
});

// 验证卡密状态（前端轮询）
app.post('/api/cards/verify', (req, res) => {
    const { key, deviceId } = req.body;
    const data = readData();
    const card = data.cards.find(c => c.key === key.toUpperCase());
    if (!card) {
        return res.json({ valid: false, message: '卡密无效' });
    }
    if (!card.used) {
        return res.json({ valid: false, message: '卡密未激活' });
    }
    if (card.deviceId !== deviceId) {
        return res.json({ valid: false, message: '卡密绑定其他设备' });
    }
    if (card.expireTime && Date.now() >= card.expireTime) {
        return res.json({ valid: false, message: '卡密已过期' });
    }
    res.json({
        valid: true,
        card: {
            key: card.key,
            name: card.name,
            expireTime: card.expireTime
        }
    });
});

// 获取卡密列表（管理员）
app.get('/api/cards', (req, res) => {
    const token = req.query.token;
    if (!verifyAdminToken(token)) {
        return res.json({ success: false, message: '管理员未登录' });
    }
    const data = readData();
    res.json({ success: true, cards: data.cards });
});

// 删除卡密（管理员）
app.delete('/api/cards/:key', (req, res) => {
    const token = req.query.token;
    if (!verifyAdminToken(token)) {
        return res.json({ success: false, message: '管理员未登录' });
    }
    const data = readData();
    const idx = data.cards.findIndex(c => c.key === req.params.key.toUpperCase());
    if (idx < 0) {
        return res.json({ success: false, message: '卡密不存在' });
    }
    data.cards.splice(idx, 1);
    writeData(data);
    res.json({ success: true });
});

// 清理过期卡密（管理员）
app.post('/api/cards/clear-expired', (req, res) => {
    const { token } = req.body;
    if (!verifyAdminToken(token)) {
        return res.json({ success: false, message: '管理员未登录' });
    }
    const data = readData();
    const before = data.cards.length;
    data.cards = data.cards.filter(c => {
        if (!c.used) return true;
        if (c.duration === Infinity) return true;
        return c.expireTime && Date.now() < c.expireTime;
    });
    const cleared = before - data.cards.length;
    writeData(data);
    res.json({ success: true, cleared });
});

// 初始化预设卡密
function initPresetCards() {
    const data = readData();
    if (data.cards.length === 0) {
        const presets = [
            { type: 'hour', count: 3 },
            { type: 'week', count: 3 },
            { type: 'month', count: 3 },
            { type: 'forever', count: 2 }
        ];
        presets.forEach(p => {
            const typeInfo = CARD_TYPES[p.type];
            for (let i = 0; i < p.count; i++) {
                let key;
                do {
                    key = typeInfo.prefix + '-' + genRandomStr(6);
                } while (data.cards.find(c => c.key === key));
                data.cards.push({
                    key,
                    type: p.type,
                    duration: typeInfo.duration,
                    name: typeInfo.name,
                    createTime: Date.now(),
                    used: false,
                    usedTime: null,
                    expireTime: null,
                    deviceId: null,
                    deviceInfo: null
                });
            }
        });
        writeData(data);
        console.log('已初始化预设卡密');
    }
}

initPresetCards();

app.listen(PORT, '0.0.0.0', () => {
    console.log(`双鱼部落收益计算器已启动：http://localhost:${PORT}`);
    console.log(`局域网访问：http://192.168.5.13:${PORT}`);
    console.log(`管理员账号：${ADMIN.username}`);
    console.log(`数据文件：${DATA_FILE}`);
});
