/**
 * 全行業連鎖店家、品牌、服務與常用消費詞庫（1,000+ 詞條）。
 * 對應 src/db/seed/categories.ts 的兩層分類名稱；只在帳本存在目標分類時套用，子分類優先，不存在時自動退回主分類。
 *
 * generic：說的就是分類本身（如「早餐」「計程車」），辨識後會從備註移除；
 * specific：具體店家、品牌或商品名稱（如「星巴克」「蝦皮」「ChatGPT」），僅用於判斷分類，保留於備註。
 */
export interface Synonym {
  names: string[];
  kind: 'expense' | 'income';
  generic: string[];
  specific?: string[];
}

export const SYNONYMS: Synonym[] = [
  // ───── 飲食：手搖飲／咖啡 ─────
  {
    names: ['飲料', '飲品'],
    kind: 'expense',
    generic: ['手搖飲', '手搖', '飲料', '飲品', '飲料店', '茶飲', '咖啡廳'],
    specific: [
      '50嵐', '五十嵐', '清心', '清心福全', '可不可', '可不可熟成紅茶', '迷客夏', 'milksha',
      '麻古', '麻古茶坊', '龜記', '得正', '一芳', '茶湯會', '大苑子', '春水堂', '鮮茶道',
      '八曜', '八曜和茶', 'coco', 'coco都可', '鶴茶樓', '五桐號', '約翰紅茶', '再睡5分鐘',
      '烏弄', '康青龍', '萬波', '珍煮丹', '老虎堂', '花茶大師', '先喝道', '發發', '吃茶三千',
      '日出茶太', 'chatime', '貢茶', 'gong cha', '天仁茗茶', '喫茶小舖', 'mr.wish', '水巷茶弄',
      '茶之魔手', '茶魔', '清原', '鮮自然', '春陽茶事', '有飲', '七盞茶', '白巷子', '樺達奶茶',
      '上宇林', '老賴茶棧', '翰林茶館', '樂法', 'comebuy', '約翰紅茶公司', '十盛', '一沐日',
      '五良', '約翰', '茶聚', '布萊恩紅茶', '拾覺', '清水茶香', '署茗職茶', '抿茶', '圓石',
      'starbucks', '星巴克', 'louisa', '路易莎', 'cama', '咖碼', '85度c', '多那之', 'donutes',
      '伯朗咖啡', 'mr.brown', '丹堤咖啡', 'dante', '怡客咖啡', 'ikari', '西雅圖咖啡', '藍瓶咖啡',
      'blue bottle', '%arabica', 'arabica', '歐客佬', 'oklao', '黑沃咖啡', 'hwcroasters',
      '彼得好咖啡', '奎克咖啡', '成真咖啡', 'cometrue', '客美多', 'komeda', 'costa coffee',
      'tullys', '上島珈琲', '星乃珈琲', 'nespresso', 'ucc', '珍奶', '珍珠奶茶', '奶茶',
      '紅茶', '綠茶', '青茶', '烏龍茶', '果汁', '汽水', '可樂', '咖啡', '拿鐵', '美式', '冰沙',
      '麥香', '純喫茶', '左岸咖啡', '貝納頌', '韋恩咖啡',
    ],
  },

  // ───── 飲食：早餐／早午餐 ─────
  {
    names: ['早餐', '飲食'],
    kind: 'expense',
    generic: ['早餐', '早點', '早飯', '早午餐', 'brunch'],
    specific: [
      '永和豆漿', '世界豆漿大王', '阜杭豆漿', '美而美', '瑞麟美而美', '麥味登', '拉亞漢堡', '拉亞',
      '早安美芝城', '美芝城', '弘爺漢堡', '弘爺', 'qburger', 'q burger', 'a-bao', '阿寶早餐',
      '晨間廚房', '蕃茄村', '橘子廚房', '呷尚寶', '巨森早餐', '東方美', '亞米亞米', '味亦美',
      '找餐店', '貳樓', 'second floor', '樂子', 'the diner', '好初早餐', '真芳', '扶旺號',
      '豐盛號', '高三孝', '吐司男', '早到晚到', '福來早餐', 'sarabeths', 'eggslut', '麥町吐司工房',
      '蛋餅', '飯糰', '吐司', '燒餅', '豆漿', '蘿蔔糕', '三明治', '鐵板麵', '油條', '饅頭夾蛋',
    ],
  },

  // ───── 飲食：午餐／晚餐／速食／餐廳／外送 ─────
  {
    names: ['午餐', '飲食', '外食', '餐飲'],
    kind: 'expense',
    generic: ['午餐', '午飯', '中餐'],
    specific: [
      // 速食／炸雞／披薩／漢堡
      '麥當勞', 'mcdonalds', '肯德基', 'kfc', '漢堡王', 'burger king', '摩斯漢堡', '摩斯', 'mos burger',
      '頂呱呱', 'tkk', '必勝客', 'pizza hut', '達美樂', 'dominos', '拿坡里', '21世紀風味館', '21plus',
      '胖老爹', '繼光香香雞', '德克士', 'dicos', 'popeyes', 'shake shack', 'subway', '潛艇堡',
      '溫蒂漢堡', '丹丹漢堡', '樂檸漢堡', 'kua aina', 'nene chicken', '起家雞', 'bb.q chicken',
      '橋村炸雞', 'bonchon', '本村炸雞', '拿坡里炸雞', '昌平炸雞王', '惡魔雞排', '天使雞排',
      '派克雞排', '豪大大雞排', '師園鹽酥雞', '台灣第一家鹽酥雞',
      // 便當／台式／水餃／牛肉麵
      '八方雲集', '四海遊龍', '梁社漢', '梁社漢排骨', '鬍鬚張', '三商巧福', '悟饕', '池上飯包',
      '池上', '正忠排骨飯', '君悅排骨', '東一排骨', '太師傅', '劉江便當', '玉欣珍', '大埔鐵板燒',
      '鼎泰豐', '朱記', '高記', '點水樓', '段純貞', '老董牛肉麵', '林東芳', '永康牛肉麵',
      '洪師傅', '劉山東', '忠青商行', '雙月食品社', '金峰魯肉飯', '天天利', '矮仔財', '今大魯肉飯',
      '阿宗麵線', '度小月', '鬍子茶', '五花馬', '老先覺', '三媽臭臭鍋', '麗媽四季鍋', '大呼過癮',
      '六扇門', '三顧茅廬', '潮味決', '丐幫滷味', '健人蓋飯', '坂田家', '野人舒食', 'miss energy',
      // 王品與連鎖集團
      '王品', '西堤', 'tasty', '陶板屋', '品田牧場', '原燒', '聚北海道鍋物', '石二鍋', '12mini',
      '青花驕', '和牛涮', '嚮辣', '享鴨', '丰禾', '初瓦', '阪前', '肉次方', '藝奇', 'ikki',
      '夏慕尼', 'hot 7', '就饗鐵板燒',
      // 鍋物／燒肉／日韓泰義／自助餐
      '錢都', '築間', '馬辣', '新馬辣', '問鼎', '海底撈', '鼎王', '無老鍋', '這一鍋', '這一小鍋',
      '肉多多', '狂一鍋', '嗑肉石鍋', '鍋爸', '千葉火鍋', '涮乃葉', 'momo paradise', '溫野菜',
      '壽喜燒一丁', '辛殿', '滿堂紅', '橘色涮涮屋', '萬客什鍋', '雞湯大叔', '尬鍋', '輕井澤',
      '拾七', '湯棧', '茶六', '屋馬', '乾杯', '老乾杯', '燒肉同話', '炭佐麻里', '燒肉smile',
      '牛角', '胡同燒肉', '姜滿堂', '兩餐', '豆腐村', '涓豆腐', '北村豆腐家', '韓姜熙', '新麻蒲海鷗',
      '瓦城', '非常泰', '大心', '1010湘', '時時香', 'nara thai', '晶湯匙', '紅舍', '開飯川食堂',
      '饗食天堂', '饗饗', '旭集', '漢來海港', '欣葉', '欣葉日本料理', '豐food', '柏麗廳',
      '探索廚房', '十二廚', '彩匯', '真珠台灣家味',
      // 日式丼飯／壽司／拉麵／豬排／義式
      'sukiya', 'すき家', '吉野家', 'yoshinoya', '松屋', 'matsuya', '藏壽司', 'kura sushi',
      '壽司郎', 'sushiro', '爭鮮', 'hama壽司', '一條通', '點爭鮮', '合點壽司', '定食8',
      '大戶屋', 'ootoya', '彌生軒', 'yayoi', '勝博殿', '杏子豬排', '福勝亭', '靜岡勝政',
      '丸龜製麵', '花月嵐', '一蘭拉麵', '一蘭', '屯京拉麵', '凪nagi', '鬼金棒', '麵屋一燈',
      '山頭火', '一風堂', 'ippudo', '樂麵屋', '三田製麵所', '薩莉亞', 'saizeriya', '古拉爵',
      'grazie', '莫凡彼', '薄多義', 'bite 2 eat', '卡布里喬莎', '洋城', '米塔', '洋朵',
      'nu pasta', 'skylark', '藍屋', '涮乃葉', '金色三麥', 'le ble dor', 'friday', 'tgi fridays',
      'texas roadhouse', 'chilis', 'chilis美式餐廳', 'outback', 'gb鮮釀',
      // 外送平台與泛餐飲詞
      'ubereats', 'uber eats', 'foodpanda', '空腹熊貓',
      '便當', '自助餐', '水餃', '手工水餃', '鍋貼', '餃子', '牛肉麵', '陽春麵', '乾麵',
      '拉麵', '烏龍麵', '義大利麵', '麵店', '麵館', '炒飯', '蓋飯', '丼飯', '滷肉飯',
      '雞肉飯', '排骨飯', '雞腿飯', '咖哩', '健康餐', '輕食', '沙拉', '素食', '外送',
    ],
  },

  // ───── 飲食：晚餐／宵夜／聚餐 ─────
  {
    names: ['晚餐', '午餐', '飲食', '外食', '餐飲'],
    kind: 'expense',
    generic: ['晚餐', '晚飯'],
    specific: [
      '火鍋', '小火鍋', '麻辣鍋', '涮涮鍋', '燒肉', '燒烤', '居酒屋', '壽司', '牛排',
      '鐵板燒', '鹹酥雞', '雞排', '鹽水雞', '滷味', '小吃', '餐廳', '餐館', '熱炒', '快炒', '夜市',
      '我家牛排', '貴族世家', '孫東寶', '赤鬼牛排', '瀧厚炙燒熟成牛排', '史堤克',
    ],
  },
  { names: ['宵夜', '晚餐', '飲食'], kind: 'expense', generic: ['宵夜', '消夜'] },
  { names: ['聚餐', '飲食'], kind: 'expense', generic: ['聚餐', '聚會', '吃飯聚'] },

  // ───── 飲食：點心／烘焙／冰品 ─────
  {
    names: ['點心', '飲食'],
    kind: 'expense',
    generic: ['點心', '零食', '甜點', '下午茶'],
    specific: [
      '聖瑪莉', 'sunmerry', '義美', '順成蛋糕', '幾分甜', '馬可先生', '一之軒', '聖保羅',
      '亞尼克', 'lady m', '哈根達斯', 'haagen dazs', 'cold stone', '酷聖石', '31冰淇淋',
      'baskin robbins', 'mister donut', 'krispy kreme', 'auntie annes', 'uncle tetsu', '徹思叔叔',
      '微熱山丘', '舊振南', '郭元益', '維格餅家', '佳德鳳梨酥', '小潘鳳梨酥', '不二坊',
      '鮮芋仙', '豆花莊', '騷豆花', '海邊走走', '青鳥旅行', 'paul', '吳寶春', '野上麵包',
      '哈肯鋪', '福利麵包', '紅葉蛋糕', '橘村屋', 'pablo', 'bake cheese tart', 'godiva',
      '見澤屋', '快車肉乾', '垂坤', '盛香珍',
      '蛋糕', '餅乾', '冰淇淋', '甜甜圈', '麵包', '烘焙', '可頌', '貝果', '鬆餅', '豆花',
      '仙草', '紅豆餅', '車輪餅', '泡芙', '胡椒餅',
    ],
  },

  // ───── 飲食：超市／食材／生鮮 ─────
  {
    names: ['食材', '飲食'],
    kind: 'expense',
    generic: ['食材', '買菜', '菜錢'],
    specific: [
      '全聯', 'px mart', '大全聯', '家樂福', 'carrefour', '好市多', 'costco', '大潤發', 'rt mart',
      '愛買', 'a mart', '美廉社', 'simple mart', '楓康超市', '喜互惠', '裕毛屋', '微風超市',
      'breeze super', 'jasons', 'mia cbon', 'city super', '聖德科斯', '棉花田', '里仁',
      '主婦聯盟', '有機緣地', '熊媽媽買菜網', 'iopen mall', '超市', '生鮮', '菜市場', '水果', '黃昏市場',
    ],
  },

  // ───── 購物：網購／電商 ─────
  {
    names: ['網購', '購物'],
    kind: 'expense',
    generic: ['網購', '線上購物', '網路購物', '電商'],
    specific: [
      '蝦皮', 'shopee', '蝦皮購物', '蝦皮店到店', 'momo', 'momo購物', 'momo購物網',
      'pchome', 'pchome 24h', '24h購物', 'coupang', '酷澎', 'yahoo購物', 'yahoo奇摩購物',
      'yahoo拍賣', '露天拍賣', 'ruten', '博客來', 'books.com', '誠品線上', '金石堂網書',
      '讀冊', 'taaze', '淘寶', 'taobao', '天貓', 'tmall', '京東', 'jd.com', '拼多多', '拚多多',
      'amazon', '亞馬遜', 'ebay', 'rakuten', '樂天市場', 'pinkoi', '生活市集', '松果購物',
      '東森購物', 'etmall', '森森購物', 'viva購物', '旋轉拍賣', 'carousell', 'gomaji',
      'iherb', 'lookfantastic', 'selfridges', 'farfetch', 'ssense', 'shopbop', 'asos',
      'shein', 'temu', 'zalora', 'yoox', 'mytheresa', 'mercari', '煤爐', 'buyee', '樂淘',
    ],
  },

  // ───── 購物：百貨／超商／雜貨／量販 ─────
  {
    names: ['雜貨', '購物', '日用品'],
    kind: 'expense',
    generic: ['雜貨', '採買', '逛街', '百貨'],
    specific: [
      '新光三越', 'skm', 'sogo', '遠東sogo', '遠東百貨', '遠百', '大遠百', 'mega city',
      '微風廣場', '微風南山', '微風松高', '微風信義', '台北101', 'taipei 101', 'att 4 fun',
      '京站', 'q square', '統一時代', 'citylink', 'lalaport', '三井outlet', 'mitsui outlet',
      '華泰名品城', 'gloria outlets', '漢神百貨', '漢神巨蛋', '夢時代', 'dream mall', '義享天地',
      '大立百貨', '中友百貨', '廣三sogo', '勤美誠品', 'skm park', '環球購物中心', 'global mall',
      '大江購物中心', '巨城', 'big city', '南紡購物中心', '唐吉訶德', 'don don donki', 'donki',
      '無印良品', 'muji', '大創', 'daiso', '小北百貨', '勝立百貨', '金興發', '光南', '九乘九',
      '寶家', 'poya home', 'hands', '台隆手創館', 'plaza', 'francfranc', 'tokyu hands',
      '7-11', '7-eleven', '7eleven', '全家', 'familymart', '萊爾富', 'hi-life', 'hilife',
      'ok超商', 'ok mart', 'ok便利商店', '超商', '便利商店',
    ],
  },

  // ───── 購物：服飾／鞋包／配件 ─────
  {
    names: ['衣物', '購物'],
    kind: 'expense',
    generic: ['買衣服', '衣服', '衣物', '服飾', '褲子', '外套'],
    specific: [
      'uniqlo', '優衣庫', 'gu', 'zara', 'h&m', 'gap', 'net', 'lativ', 'pazzo', 'meier q',
      'air space', 'ob嚴選', 'fifty percent', '50%', 'caco', 'stayreal', 'roots', 'levis',
      'lee', 'edwin', 'tommy hilfiger', 'ralph lauren', 'polo', 'calvin klein', 'ck',
      'pull&bear', 'bershka', 'massimo dutti', 'cos', 'arket', 'mango', 'muji服飾',
      'the north face', 'tnf', 'patagonia', 'columbia', 'arcteryx', '始祖鳥', 'montbell',
      'snow peak', 'lululemon', 'alo yoga', 'under armour', 'ua', '迪卡儂', 'decathlon',
      'giordano', '佐丹奴', 'hang ten', 'bossini', 'baleno', 'g2000',
    ],
  },
  {
    names: ['鞋子', '購物'],
    kind: 'expense',
    generic: ['買鞋', '鞋子', '球鞋', '運動鞋', '皮鞋'],
    specific: [
      'nike', 'adidas', '愛迪達', 'new balance', 'puma', 'reebok', 'asics', '亞瑟士',
      'mizuno', '美津濃', 'skechers', 'converse', 'vans', 'timberland', 'dr. martens',
      'crocs', 'birkenstock', 'hoka', 'on running', 'salomon', 'abc-mart', '摩曼頓',
      '尚智', '微笑運動', '阿瘦皮鞋', 'aso', 'la new', 'd+af', 'anns', 'grace gift',
    ],
  },
  {
    names: ['配件', '購物'],
    kind: 'expense',
    generic: ['配件', '包包', '眼鏡', '手錶', '飾品'],
    specific: [
      'louis vuitton', 'chanel', 'hermes', 'gucci', 'prada', 'dior', 'burberry', 'loewe',
      'celine', 'bottega veneta', 'balenciaga', 'coach', 'michael kors', 'kate spade',
      'longchamp', 'tory burch', 'marc jacobs', 'porter', 'kanken', 'fjallraven', 'gregory',
      'samsonite', 'rimowa', 'eminent', 'jins', 'owndays', '眼鏡市場', '寶島眼鏡',
      '小林眼鏡', '得恩堂', '仁愛眼鏡', 'pandora', 'swarovski', 'tiffany', 'cartier',
      'vacanza', 'bonny & read', 'casio', 'g-shock', 'seiko', 'swatch', 'garmin',
    ],
  },

  // ───── 購物：美妝保養／美髮 ─────
  {
    names: ['美妝保養', '購物'],
    kind: 'expense',
    generic: ['美妝', '保養品', '化妝品', '護膚', '香水'],
    specific: [
      '寶雅', 'poya', '屈臣氏', 'watsons', '康是美', 'cosmed', '日藥本舖', '松本清',
      'matsumoto kiyoshi', 'tomods', '特美事', 'sasa', '莎莎', 'sephora', '絲芙蘭',
      'nars', 'ysl', 'bobbi brown', 'estee lauder', '雅詩蘭黛', 'lancome', '蘭蔻',
      'sk-ii', 'skii', '資生堂', 'shiseido', 'kiehls', '契爾氏', 'clinique', '倩碧',
      'origins', '品木宣言', 'aesop', 'jo malone', 'diptyque', 'sabon', 'loccitane', '歐舒丹',
      'the body shop', 'innisfree', 'etude', 'laneige', '蘭芝', '植村秀', 'shu uemura',
      'kose', '高絲', 'kanebo', '佳麗寶', 'dhc', 'dr.wu', '理膚寶水', 'la roche posay',
      'cerave', '適樂膚', 'avene', '雅漾', 'bioderma', '貝膚黛瑪',
    ],
  },
  {
    names: ['美髮', '購物'],
    kind: 'expense',
    generic: ['剪髮', '理髮', '美髮', '染髮', '燙髮', '洗頭'],
    specific: ['小林髮廊', '曼都髮型', '名留髮型', 'at髮型', 'qb house', '百元快剪', 'cq2', '快剪100', 'happyhair', 'aveda', 'jiujitsu salon'],
  },

  // ───── 購物：3C 數位／居住：家具家電 ─────
  {
    names: ['3C 數位', '購物'],
    kind: 'expense',
    generic: ['3c', '手機', '筆電', '電腦', '耳機', '平板', '相機', '充電線'],
    specific: [
      'apple store', 'studio a', '德誼數位', 'data express', 'istore', '燦坤', '順發3c',
      '良興', 'eclife', '原價屋', 'coolpc', '欣亞數位', '三井3c', 'samsung', '三星智慧館',
      'sony', '小米之家', 'xiaomi', 'oppo', 'vivo', 'asus', '華碩', 'acer', '宏碁',
      'msi', '微星', 'dell', 'hp', 'lenovo', 'logitech', '羅技', 'razer', '雷蛇',
      'anker', 'baseus', '倍思', 'ugreen', '綠聯', 'bose', 'sennheiser', 'canon', 'nikon', 'fujifilm', 'gopro', 'dji',
    ],
  },
  {
    names: ['家具家電', '居住'],
    kind: 'expense',
    generic: ['家具', '家電', '傢俱', '床墊', '沙發', '冷氣', '冰箱', '洗衣機'],
    specific: [
      'ikea', '宜家', '宜家家居', '宜得利', 'nitori', '特力屋', 'hola', '生活工場',
      '全國電子', 'dyson', '戴森', 'lg', 'panasonic', '國際牌', 'hitachi', '日立',
      'sharp', '夏普', 'daikin', '大金', '大同', 'sampo', '聲寶', '歌林', 'philips', '飛利浦',
      '詩肯柚木', '有情門', '歐德傢俱', '綠的傢俱', 'emma床墊', '眠豆腐', 'hoi好好生活', 'mr.living',
    ],
  },
  {
    names: ['日用品', '居住'],
    kind: 'expense',
    generic: ['日用品', '衛生紙', '洗衣精', '清潔劑', '垃圾袋', '洗髮精', '沐浴乳'],
    specific: ['舒潔', '五月花', '春風', '倍潔雅', '得意', '白蘭', '一匙靈', '橘子工坊', '毛寶', '威猛先生', '花王'],
  },

  // ───── 訂閱：AI／雲端軟體／影音串流／音樂串流／會員 ─────
  {
    names: ['雲端軟體', '訂閱'],
    kind: 'expense',
    generic: ['訂閱軟體', '雲端空間', 'ai訂閱', '軟體訂閱'],
    specific: [
      'chatgpt', 'openai', 'claude', 'anthropic', 'gemini', 'google ai', 'google one',
      'perplexity', 'cursor', 'github', 'github copilot', 'copilot', 'windsurf', 'codeium',
      'midjourney', 'runway', 'elevenlabs', 'suno', 'udio', 'kling', 'grok', 'poe',
      'notion', 'linear', 'figma', 'canva', 'adobe', 'creative cloud', 'photoshop', 'lightroom',
      'microsoft 365', 'office 365', 'onedrive', 'icloud', 'icloud+', 'dropbox', 'box',
      '1password', 'bitwarden', 'dashlane', 'lastpass', 'nordvpn', 'expressvpn', 'surfshark',
      'proton', 'protonmail', 'zoom', 'slack', 'raycast', 'setapp', 'evernote', 'todoist',
      'obsidian', 'readwise', 'grammarly', 'deepl', 'tailscale', 'cloudflare', 'vercel',
      'aws', 'gcp', 'azure', 'digitalocean', 'supabase', 'netlify', 'namecheap', 'godaddy',
    ],
  },
  {
    names: ['影音串流', '訂閱'],
    kind: 'expense',
    generic: ['影音訂閱', '串流平台', '追劇'],
    specific: [
      'netflix', '網飛', 'disney+', 'disney plus', 'youtube premium', 'hbo', 'hbo max',
      'apple tv+', 'prime video', '愛奇藝', 'iqiyi', 'friday影音', 'line tv', 'myvideo',
      'kktv', 'hami video', 'catchplay', 'catchplay+', '動畫瘋', '巴哈姆特動畫瘋', 'bilibili',
      'crunchyroll', 'twitch', 'dazn', '愛爾達', 'elta',
    ],
  },
  {
    names: ['音樂串流', '訂閱'],
    kind: 'expense',
    generic: ['音樂訂閱', '聽歌'],
    specific: ['spotify', 'kkbox', 'apple music', 'youtube music', 'tidal', 'streetvoice', 'amazon music'],
  },
  {
    names: ['會員', '訂閱'],
    kind: 'expense',
    generic: ['會員費', '年費', '月費', '訂閱'],
    specific: [
      'uber one', 'pandapro', 'amazon prime', 'apple one', 'costco會員', '蝦皮vip',
      'switch online', 'nintendo switch online', 'ps plus', 'playstation plus',
      'xbox game pass', 'game pass', 'ea play', 'patreon', 'substack',
    ],
  },

  // ───── 娛樂：樂園／電影／遊戲／演出／書籍／健身／旅遊 ─────
  {
    names: ['娛樂', '旅遊'],
    kind: 'expense',
    generic: ['樂園', '遊樂園', '主題樂園', '門票', '玩樂', '唱歌', 'ktv', '娛樂'],
    specific: [
      '兒童新樂園', '六福村', '劍湖山', '麗寶樂園', '九族文化村', '義大遊樂世界', '小人國',
      'xpark', '海生館', '屏東海生館', '遠雄海洋公園', '野柳海洋世界', '動物園', '木柵動物園',
      '台北市立動物園', '壽山動物園', '新竹動物園', '頑皮世界', '浦心牧場', '飛牛牧場',
      '綠世界', '科教館', '天文館', '故宮', '奇美博物館', '科工館', '科博館', '尚順育樂世界',
      '鈴鹿賽道樂園', '大魯閣', '湯姆熊', 'e7play', '奧斯丁夢想樂園', '貝兒絲樂園', '騎士堡',
      '迪士尼', 'disneyland', 'disneysea', '環球影城', 'universal studios', '樂高樂園', 'legoland',
      '富士急', '錢櫃', 'partyworld', '好樂迪', 'holiday', '星聚點', '享溫馨', '凱悅ktv',
      'oncor', '密室逃脫', '劇本殺', '桌遊', '保齡球', '撞球', '射箭', '攀岩', '滑雪', '泡湯', '溫泉',
    ],
  },
  {
    names: ['電影', '娛樂'],
    kind: 'expense',
    generic: ['電影', '看電影', '電影票'],
    specific: [
      '威秀', '威秀影城', 'vieshow', '秀泰', '秀泰影城', 'showtimes', '國賓影城', '國賓',
      '美麗華影城', '美麗華大直影城', '新光影城', 'in89', '豪華數位影城', '喜樂時代', '樂聲影城',
      '光點華山', '光點台北', '真善美戲院', '梅花數位影院', '威尼斯影城', 'imax',
    ],
  },
  {
    names: ['音樂演出', '娛樂'],
    kind: 'expense',
    generic: ['演唱會', '音樂會', '展覽', '舞台劇', '看展'],
    specific: ['opentix', '兩廳院', '拓元', 'tixcraft', '寬宏售票', 'kktix', 'ibon售票', 'famiticket', '年代售票', 'udn售票網'],
  },
  {
    names: ['遊戲', '娛樂'],
    kind: 'expense',
    generic: ['遊戲', '買遊戲', '課金', '點數卡', '手遊'],
    specific: [
      'steam', 'valve', 'playstation', 'psn', 'nintendo', '任天堂', 'eshop', 'xbox',
      'epic games', 'blizzard', '暴雪', 'riot games', '英雄聯盟', '特戰英豪', 'garena',
      'mycard', 'app store', 'google play', '寶可夢', '原神', '崩壞', '絕區零', '傳說對決',
      '天堂m', '楓之谷', '魔獸世界', 'ff14', 'sega', 'capcom', 'bandai', '萬代', '寶可夢中心',
    ],
  },
  {
    names: ['運動健身', '娛樂'],
    kind: 'expense',
    generic: ['健身房', '健身', '運動', '游泳', '瑜珈', '重訓', '教練課'],
    specific: [
      'world gym', '世界健身', '健身工廠', 'fitness factory', 'curves', '可爾姿',
      'true yoga', '全真瑜珈', '成吉思汗', '國民運動中心', 'space cycle', 'hypercore',
      '超核心', 'more fit', '打鐵健身', 'anytime fitness',
    ],
  },
  {
    names: ['書籍', '娛樂'],
    kind: 'expense',
    generic: ['買書', '書', '書籍', '電子書', '雜誌'],
    specific: ['誠品書店', '誠品', '金石堂', '三民書局', '墊腳石', '紀伊國屋', '蔦屋書店', 'tsutaya', 'readmoo', '讀墨', 'kobo', 'kindle', '法雅客', '敦煌書局'],
  },
  {
    names: ['課程', '學費', '考試證照', '娛樂'],
    kind: 'expense',
    generic: ['課程', '學費', '補習', '考試', '報名費', '證照'],
    specific: [
      'hahow', '好學校', 'udemy', 'coursera', 'edx', 'pressplay', 'yotta', 'masterclass',
      'amazingtalker', 'cambly', 'nativecamp', 'engoo', 'tutorabc', '巨匠電腦', '聯成電腦',
      '地球村', '菁英國際', '多益', 'toeic', '雅思', 'ielts', '托福', 'toefl', '全民英檢',
      'gept', '日檢', 'jlpt', '考選部',
    ],
  },

  // ───── 交通 ─────
  {
    names: ['計程車', '交通'],
    kind: 'expense',
    generic: ['計程車', '小黃', '叫車', '搭車'],
    specific: ['uber', '55688', '台灣大車隊', 'yoxi', 'line taxi', 'line go', 'bolt', 'grab', 'gojek', '大都會車隊', '皇冠大車隊', 'irent', '和運租車', '格上租車', '中租租車', 'avis', 'hertz'],
  },
  {
    names: ['捷運公車', '交通'],
    kind: 'expense',
    generic: ['捷運', '公車', '客運', '輕軌', '渡輪'],
    specific: [
      '悠遊卡', 'easycard', '一卡通', 'ipass', 'icash', '愛金卡', 'tpass',
      '北捷', '台北捷運', '高捷', '高雄捷運', '中捷', '台中捷運', '機捷', '桃園捷運',
      'ubike', 'youbike', 'wemo', 'goshare', '統聯', '統聯客運', '國光客運', '和欣客運',
      '葛瑪蘭客運', '首都客運', '三重客運', '指南客運', '台北客運',
    ],
  },
  {
    names: ['高鐵火車', '交通'],
    kind: 'expense',
    generic: ['高鐵', '台鐵', '火車', '區間車', '自強號', '普悠瑪', '太魯閣'],
    specific: ['台灣高鐵', 'thsr', '臺鐵', 't-express'],
  },
  {
    names: ['加油', '交通'],
    kind: 'expense',
    generic: ['加油', '油錢', '汽油', '柴油', '充電費'],
    specific: [
      '中油', '台灣中油', 'cpc', '台塑石油', '台亞石油', '全國加油站', '山隆加油站',
      '福懋加油站', '西歐加油站', '速邁樂', 'smile加油站', 'gogoro', 'gostation',
      'tesla', '超充', 'u-power', 'evoasis', 'icharging', 'evalue', '華城電能', 'noodoe',
    ],
  },
  {
    names: ['停車', '交通'],
    kind: 'expense',
    generic: ['停車', '停車費', '路邊停車', '月租車位'],
    specific: ['autopass', '車麻吉', 'utaggo', 'times停車', 'times', '台灣聯通', '嘟嘟房', '城市車旅', 'vivi park', '應安停車場', '俥亭停車'],
  },
  {
    names: ['ETC 過路', '交通'],
    kind: 'expense',
    generic: ['過路費', '高速公路'],
    specific: ['etag', 'etc', '遠通電收'],
  },
  {
    names: ['保養維修', '交通'],
    kind: 'expense',
    generic: ['修車', '保養', '換輪胎', '洗車', '換機油', '汽車美容'],
    specific: ['車麗屋', '汽車百貨', '金弘笙', '普利司通', '米其林', 'michelin', 'toyota原廠', 'honda原廠', 'ymsp', '光陽', '三陽', 'yamaha機車'],
  },
  {
    names: ['機票', '旅遊', '交通'],
    kind: 'expense',
    generic: ['機票', '出國', '住宿', '訂房', '飯店', '旅館', '民宿'],
    specific: [
      '長榮航空', 'eva air', '中華航空', '華航', 'china airlines', '星宇航空', 'starlux',
      '台灣虎航', 'tigerair', '樂桃航空', 'peach', '酷航', 'scoot', '捷星', 'jetstar',
      '亞航', 'airasia', '國泰航空', 'cathay pacific', '日航', 'jal', '全日空', 'ana',
      '韓亞航', '大韓航空', 'korean air', 'agoda', 'booking.com', 'booking', 'airbnb',
      'hotels.com', 'expedia', 'trip.com', 'eztravel', '易遊網', '雄獅旅遊', '可樂旅遊',
      '東南旅遊', '山富旅遊', '五福旅遊', 'kkday', 'klook', '晶華酒店', '君悅', '萬豪',
      'marriott', 'hilton', '希爾頓', 'hyatt', '老爺酒店', '煙波大飯店', '承億文旅', '福容大飯店',
      '亞太飯店', '東橫inn', 'toyoko inn', 'apa hotel', 'dormy inn',
    ],
  },

  // ───── 居住：水電瓦斯（無細分子分類時自動退回稅費或居住）／電信／房租 ─────
  {
    names: ['水電瓦斯', '稅費', '居住'],
    kind: 'expense',
    generic: ['水電', '電費', '水費', '瓦斯', '瓦斯費', '天然氣'],
    specific: [
      '台電', '台灣電力', '自來水', '台灣自來水', '台北自來水', '北水', '台水',
      '大台北瓦斯', '欣湖天然氣', '欣桃天然氣', '欣中天然氣', '欣欣天然氣', '欣南天然氣',
      '新海瓦斯', '陽明山瓦斯', '桶裝瓦斯', '欣林天然氣', '欣彰天然氣', '欣高瓦斯',
    ],
  },
  {
    names: ['網路電信', '居住'],
    kind: 'expense',
    generic: ['網路費', '電信費', '手機費', '電話費', '寬頻', '固網', '光世代'],
    specific: [
      '中華電信', 'chunghwa', 'hinet', 'mod', '台灣大哥大', '台哥大', '台灣之星',
      '遠傳', '遠傳電信', 'fet', '亞太電信', '凱擘大寬頻', '凱擘', '中嘉寬頻',
      '台灣寬頻', 'tbc', '大大寬頻', '台數科', '星鏈', 'starlink',
    ],
  },
  { names: ['房租', '居住'], kind: 'expense', generic: ['房租', '租金', '租屋'], specific: ['591租屋', '兆基物業'] },
  { names: ['房貸', '居住'], kind: 'expense', generic: ['房貸', '房屋貸款'] },
  { names: ['管理費', '居住'], kind: 'expense', generic: ['管理費', '社區管理費', '大樓管理費'] },
  { names: ['修繕', '居住'], kind: 'expense', generic: ['修繕', '水電維修', '通水管', '換鎖'], specific: ['潔客幫', 'pro360', '特力屋居家修繕'] },

  // ───── 醫療／藥局／牙醫／保險 ─────
  {
    names: ['門診', '醫療'],
    kind: 'expense',
    generic: ['看醫生', '掛號', '門診', '診所', '醫院'],
    specific: [
      '台大醫院', '臺大醫院', '榮總', '台北榮總', '台中榮總', '高雄榮總', '長庚醫院',
      '林口長庚', '高雄長庚', '馬偕醫院', '國泰醫院', '新光醫院', '亞東醫院', '萬芳醫院',
      '慈濟醫院', '奇美醫院', '成大醫院', '中國醫藥大學附設醫院', '中國醫', '高醫', '彰基',
      '北醫附醫', '雙和醫院', '恩主公醫院', '耳鼻喉科', '皮膚科', '眼科', '復健科',
      '中醫', '小兒科', '家醫科', '婦產科', '身心科', '骨科', '泌尿科',
    ],
  },
  {
    names: ['藥品', '醫療'],
    kind: 'expense',
    generic: ['藥局', '買藥', '藥品', '保健食品', '維他命'],
    specific: ['大樹藥局', '丁丁藥局', '佑全', '佑全保健藥妝', '杏一', '杏一醫療', '維康醫療', '啄木鳥藥局', '躍獅藥局', '全球藥局', '健康人生藥局'],
  },
  { names: ['牙科', '醫療'], kind: 'expense', generic: ['牙醫', '洗牙', '牙科', '植牙', '矯正'] },
  { names: ['健檢', '醫療'], kind: 'expense', generic: ['健檢', '健康檢查'], specific: ['聯安診所', '美兆健檢', '哈佛健檢'] },
  {
    names: ['壽險', '醫療險', '車險', '醫療'],
    kind: 'expense',
    generic: ['保費', '保險', '壽險', '醫療險', '車險', '意外險', '旅平險'],
    specific: [
      '國泰人壽', '富邦人壽', '南山人壽', '新光人壽', '台灣人壽', '中國人壽', '凱基人壽',
      '三商美邦', '全球人壽', '遠雄人壽', '保誠人壽', '安聯人壽', '富邦產險', '國泰產險',
      '新安東京', '和泰產險', '明台產險', '華南產險',
    ],
  },
  { names: ['健保勞保', '稅費', '醫療'], kind: 'expense', generic: ['健保', '健保費', '勞保', '勞保費', '國民年金'] },

  // ───── 投資：購買股票（系統分類「股票買進」優先，次之股票／交易手續費） ─────
  {
    names: ['股票買進', '股票', '交易手續費', '稅費'],
    kind: 'expense',
    generic: ['購買股票', '買股票', '買股', '買進股票', '定期定額買股'],
    specific: [
      '買台股', '買美股', '台股', '美股', '零股', 'etf', '股票交割',
      '元大證券', '凱基證券', '富邦證券', '國泰證券', '永豐金證券', '永豐證券', '玉山證券',
      '台新證券', '群益證券', '統一證券', '兆豐證券', '華南永昌', '第一金證券', '合庫證券',
      '新光證券', '國票證券', 'firstrade', 'interactive brokers', 'ibkr', 'charles schwab',
      '嘉信理財', 'etoro', '口袋證券',
    ],
  },

  // ───── 稅費／銀行手續費 ─────
  {
    names: ['所得稅', '房屋地價稅', '牌照燃料稅', '稅費'],
    kind: 'expense',
    generic: ['稅費', '繳稅', '報稅', '所得稅', '綜所稅', '房屋稅', '地價稅', '牌照稅', '燃料稅', '燃料費', '使用牌照稅', '營業稅', '關稅', '印花稅', '罰單', '交通罰鍰', '規費'],
    specific: ['監理站', '國稅局', '稅捐處', '電子報稅', 'paytax', '台灣pay繳稅', 'ezway關稅', '驗車費', '護照規費'],
  },
  { names: ['銀行手續費', '稅費'], kind: 'expense', generic: ['跨轉手續費', '轉帳手續費', '匯款手續費', 'atm手續費', '年費'] },

  // ───── 家庭／寵物／捐款 ─────
  { names: ['紅白包', '家庭'], kind: 'expense', generic: ['紅包', '白包', '禮金', '包紅包'] },
  { names: ['請客', '家庭'], kind: 'expense', generic: ['請客'] },
  { names: ['禮物', '家庭'], kind: 'expense', generic: ['禮物', '送禮', '伴手禮'] },
  { names: ['孝親', '家庭'], kind: 'expense', generic: ['孝親', '孝親費', '給爸媽'] },
  { names: ['育兒', '家庭'], kind: 'expense', generic: ['奶粉', '尿布', '托嬰', '幼兒園', '保母'], specific: ['卡多摩', '大樹親子', '丁丁婦幼', '麗嬰房', 'mamaway', '媽媽餵', '幫寶適', '妙而舒', '好奇', '滿意寶寶', '明治奶粉', '亞培', '能恩'] },
  { names: ['獸醫', '家庭'], kind: 'expense', generic: ['獸醫', '看獸醫', '動物醫院', '寵物醫院'] },
  { names: ['飼料', '用品', '家庭'], kind: 'expense', generic: ['貓砂', '狗糧', '貓糧', '寵物飼料', '寵物美容'], specific: ['魚中魚', '寵物公園', '奧斯卡寵物', '東森寵物', '毛起來', '汪喵星球', '好味小姐', '怪獸部落', '倍力'] },
  { names: ['捐款', '家庭'], kind: 'expense', generic: ['捐款', '公益', '愛心捐款'], specific: ['家扶基金會', '伊甸基金會', '創世基金會', '世界展望會', '紅十字會', '兒福聯盟', '喜憨兒', '心路基金會', '勵馨基金會', '荒野保護協會', '綠色和平'] },

  // ───── 收入 ─────
  { names: ['薪資', '本薪'], kind: 'income', generic: ['薪水', '月薪', '薪資', '發薪', '底薪'] },
  { names: ['加班費', '薪資'], kind: 'income', generic: ['加班費'] },
  { names: ['零用金', '薪資'], kind: 'income', generic: ['零用金', '零用錢'] },
  { names: ['獎金', '年終', '績效'], kind: 'income', generic: ['獎金', '年終', '年終獎金', '三節獎金', '績效獎金', '分紅'] },
  { names: ['兼職外快', '兼職'], kind: 'income', generic: ['兼職', '外快', '接案', '稿費', '演講費', '家教費'] },
  { names: ['禮金紅包'], kind: 'income', generic: ['紅包', '禮金', '收紅包'] },
  { names: ['退款'], kind: 'income', generic: ['退款', '退費', '刷退', '現金回饋', '回饋金'] },
  { names: ['利息'], kind: 'income', generic: ['利息', '存款利息', '活存利息', '定存利息'] },
  { names: ['股利'], kind: 'income', generic: ['股利', '配息', '股息', '現金股利'] },
  { names: ['股票賣出', '投資收益', '已實現損益'], kind: 'income', generic: ['賣股票', '賣股', '投資收益', '證券賣出'] },
  { names: ['租金收入'], kind: 'income', generic: ['收租', '房租收入', '租金收入'] },
  { names: ['中獎'], kind: 'income', generic: ['中獎', '彩券', '發票中獎', '刮刮樂', '大樂透', '威力彩'] },
];
