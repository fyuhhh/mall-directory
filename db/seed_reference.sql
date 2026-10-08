-- seed_reference.sql — data referensi (WP-A). Jalankan setelah db/schema.sql.
-- Idempoten: memakai INSERT ... ON DUPLICATE KEY UPDATE.
SET NAMES utf8mb4;
USE bsb_directory;

-- ---------- amenity types (§2.9) ----------
INSERT INTO amenity_types (id, name_en, name_id, icon, color, show_in_home, sort_order) VALUES
 ('toilet',            'Toilets',              'Toilet',               'bath',           '#2F5BEA', 1, 1),
 ('toilet-accessible', 'Accessible Toilet',    'Toilet Difabel',       'accessibility',  '#2F5BEA', 0, 2),
 ('musholla',          'Prayer Room',          'Musholla',             'musholla',       '#2F9E44', 1, 3),
 ('atm',               'ATM',                  'ATM',                  'banknote',       '#0B8A8A', 1, 4),
 ('info-desk',         'Information Desk',     'Pusat Informasi',      'info',           '#7B4FD6', 1, 5),
 ('parking-entrance',  'Parking',              'Parkir',               'square-parking', '#6B7280', 0, 6),
 ('lobby-exit',        'Lobby / Exit',         'Lobi / Pintu Keluar',  'door-open',      '#6B7280', 0, 7),
 ('nursery',           'Nursery Room',         'Ruang Laktasi',        'baby',           '#C2417A', 1, 8),
 ('first-aid',         'First Aid',            'P3K',                  'heart-pulse',    '#D9480F', 0, 9),
 ('charging',          'Charging Station',     'Stasiun Pengisian',    'plug-zap',       '#E0A800', 0, 10),
 ('smoking-area',      'Smoking Area',         'Area Merokok',         'cigarette',      '#857B70', 0, 11),
 ('lost-found',        'Lost & Found',         'Barang Hilang',        'package-search', '#857B70', 0, 12),
 ('wheelchair-rental', 'Wheelchair Rental',    'Peminjaman Kursi Roda','accessibility',  '#2F5BEA', 0, 13),
 ('drop-off',          'Taxi / Ride Drop-off', 'Titik Taksi / Ojol',   'car-taxi-front', '#6B7280', 0, 14)
ON DUPLICATE KEY UPDATE name_en=VALUES(name_en), name_id=VALUES(name_id), icon=VALUES(icon), color=VALUES(color),
 show_in_home=VALUES(show_in_home), sort_order=VALUES(sort_order);

-- ---------- schedules (contoh reusable) ----------
INSERT INTO schedules (name, note) VALUES ('Jam mall', 'Default 10:00-22:00 setiap hari'), ('24 jam', 'Selalu buka')
ON DUPLICATE KEY UPDATE note=VALUES(note);
INSERT IGNORE INTO schedule_rules (schedule_id, dow, open_time, close_time)
SELECT s.id, d.dow, '10:00:00', '22:00:00' FROM schedules s
JOIN (SELECT 1 dow UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7) d
WHERE s.name = 'Jam mall';
INSERT IGNORE INTO schedule_rules (schedule_id, dow, open_time, close_time)
SELECT s.id, d.dow, '00:00:00', '23:59:59' FROM schedules s
JOIN (SELECT 1 dow UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7) d
WHERE s.name = '24 jam';

-- ---------- settings default (§10.5 WP-A langkah 1) ----------
INSERT INTO settings (`key`, value) VALUES
 ('mall.hours',              '{"1":[["10:00","22:00"]],"2":[["10:00","22:00"]],"3":[["10:00","22:00"]],"4":[["10:00","22:00"]],"5":[["10:00","22:00"]],"6":[["10:00","22:00"]],"7":[["10:00","22:00"]]}'),
 ('map.northDeg',            'null'),
 ('cost.escalatorPerLevel',  '19.2'),
 ('cost.liftPerLevel',       '38.4'),
 ('cost.stairsPerLevel',     '28.8'),
 ('cost.travelatorPerLevel', '9.6'),
 ('cost.bridge',             '0'),
 ('kiosk.idleTimeoutSec',    '60'),
 ('kiosk.metersPerUnit',     '0.7'),
 ('kiosk.walkSpeedMps',      '1.2'),
 ('kiosk.escalatorSecPerLevel', '25'),
 ('kiosk.liftSecPerTrip',    '60'),
 ('kiosk.minAppBuild',       '"2026.10.1"'),
 ('public.baseUrl',          '"http://localhost/bsb-directory"'),
 ('media.cwebpPath',         '"/opt/homebrew/bin/cwebp"'),
 ('health.allowCidr',        '["127.0.0.0/8","10.0.0.0/8","172.16.0.0/12","192.168.0.0/16","::1/128"]'),
 ('retention.rawDays',       '180'),
 ('retention.heartbeatDays', '30'),
 ('retention.auditDays',     '730'),
 ('backup.dir',              '"D:\\\\bsb-backup"')
ON DUPLICATE KEY UPDATE `key`=`key`;
