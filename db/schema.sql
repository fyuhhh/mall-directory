SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;
CREATE DATABASE IF NOT EXISTS bsb_directory CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE bsb_directory;

-- ========== users & security ==========
CREATE TABLE users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  role ENUM('superadmin','map_editor','leasing','marketing','operations','security','viewer') NOT NULL DEFAULT 'viewer',
  password_hash VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  failed_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  last_login_at DATETIME NULL,
  password_changed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE login_attempts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NULL,
  ip VARCHAR(45) NOT NULL,
  success TINYINT(1) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ip_time (ip, created_at),
  KEY idx_email_time (email, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE rate_limits (
  bucket VARCHAR(120) NOT NULL,          -- mis. 'tele:kiosk:gf-pentacity', 'phone:ip:<hash>', 'login:ip:1.2.3.4'
  window_start INT UNSIGNED NOT NULL,    -- unix time dibulatkan ke awal window
  hits INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE settings (
  `key` VARCHAR(80) PRIMARY KEY,         -- 'mall.hours', 'map.northDeg', 'cost.escalatorPerLevel', 'kiosk.idleTimeoutSec', 'public.baseUrl', ...
  value JSON NOT NULL,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_settings_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- revisi per scope untuk optimistic locking & deteksi "ada perubahan belum dipublish"
CREATE TABLE revisions (
  scope ENUM('content','map','promos') PRIMARY KEY,
  rev INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== media ==========
CREATE TABLE media (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('logo','image','video','svg','other') NOT NULL,
  path VARCHAR(255) NOT NULL,            -- relatif ke app root: 'media/logos/3f9a….webp' atau seed 'assets/logos/uniqlo-gf.webp'
  path_2x VARCHAR(255) NULL,
  mime VARCHAR(64) NOT NULL,
  bytes INT UNSIGNED NOT NULL,
  width SMALLINT UNSIGNED NULL,
  height SMALLINT UNSIGNED NULL,
  duration_sec DECIMAL(6,2) NULL,
  sha256 CHAR(64) NOT NULL,
  original_name VARCHAR(190) NULL,
  alt_text VARCHAR(190) NULL,
  meta JSON NULL,                        -- laporan sanitasi SVG, encoder dipakai, dll.
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_media_sha_kind (sha256, kind),
  KEY idx_media_kind (kind),
  CONSTRAINT fk_media_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== floors ==========
CREATE TABLE floors (
  id VARCHAR(32) PRIMARY KEY,            -- 'lg-penta','lg-ewalk','gf','ug','ff-penta','ff-ewalk','sf-penta','sf-ewalk'
  level TINYINT NOT NULL,                -- -1 LG, 0 GF, 1 UG, 2 1F, 3 2F
  short VARCHAR(8) NOT NULL,
  name_en VARCHAR(80) NOT NULL,
  name_id VARCHAR(80) NOT NULL,
  building ENUM('pentacity','ewalk','both') NOT NULL,
  svg_media_id INT UNSIGNED NOT NULL,
  vb_x DECIMAL(10,3) NOT NULL DEFAULT 0,
  vb_y DECIMAL(10,3) NOT NULL DEFAULT 0,
  vb_w DECIMAL(10,3) NOT NULL,
  vb_h DECIMAL(10,3) NOT NULL,
  unit_scale DECIMAL(8,4) NOT NULL DEFAULT 1.0000,
  north_deg DECIMAL(5,1) NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_floor_level (level),
  CONSTRAINT fk_floor_svg FOREIGN KEY (svg_media_id) REFERENCES media(id),
  CONSTRAINT fk_floor_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE floor_focus (
  floor_id VARCHAR(32) NOT NULL,
  building ENUM('pentacity','ewalk') NOT NULL,
  x DECIMAL(10,2) NOT NULL, y DECIMAL(10,2) NOT NULL, w DECIMAL(10,2) NOT NULL, h DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (floor_id, building),
  CONSTRAINT fk_focus_floor FOREIGN KEY (floor_id) REFERENCES floors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== schedules (jam operasi reusable: eskalator, koridor, fasilitas) ==========
CREATE TABLE schedules (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE,      -- 'Jam mall', '24 jam', 'Eskalator LG 10:00-21:30'
  note VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE schedule_rules (
  schedule_id INT UNSIGNED NOT NULL,
  dow TINYINT UNSIGNED NOT NULL,         -- 1=Senin … 7=Minggu (ISO)
  open_time TIME NOT NULL,
  close_time TIME NOT NULL,              -- close < open = lewat tengah malam; 00:00-24:00 ditulis 00:00-23:59:59
  PRIMARY KEY (schedule_id, dow, open_time),
  CONSTRAINT fk_rule_sched FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
  CONSTRAINT chk_rule_dow CHECK (dow BETWEEN 1 AND 7)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== graph ==========
CREATE TABLE graph_nodes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,   -- diekspor sebagai 'n<id>'; seed mempertahankan nomor (n348 -> 348)
  floor_id VARCHAR(32) NOT NULL,
  x DECIMAL(10,2) NOT NULL,
  y DECIMAL(10,2) NOT NULL,
  label VARCHAR(80) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_node_floor (floor_id),
  CONSTRAINT fk_node_floor FOREIGN KEY (floor_id) REFERENCES floors(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE graph_edges (                       -- jalan kaki / tangga di dalam satu lantai
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  node_a INT UNSIGNED NOT NULL,                  -- disimpan node_a < node_b
  node_b INT UNSIGNED NOT NULL,
  type ENUM('walk','stairs') NOT NULL DEFAULT 'walk',   -- stairs: dilewati mode kursi roda
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  cost_override DECIMAL(10,2) NULL,
  schedule_id INT UNSIGNED NULL,
  label VARCHAR(80) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_edge (node_a, node_b),
  KEY idx_edge_b (node_b),
  CONSTRAINT chk_edge_order CHECK (node_a < node_b),
  CONSTRAINT fk_edge_a FOREIGN KEY (node_a) REFERENCES graph_nodes(id) ON DELETE CASCADE,
  CONSTRAINT fk_edge_b FOREIGN KEY (node_b) REFERENCES graph_nodes(id) ON DELETE CASCADE,
  CONSTRAINT fk_edge_sched FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== connectors: bank -> stop -> leg ==========
CREATE TABLE connector_banks (
  id VARCHAR(48) PRIMARY KEY,                    -- 'esc-a-penta','lift-ewalk','cross-ff'
  type ENUM('escalator','lift','stairs','bridge','travelator') NOT NULL,
  building ENUM('pentacity','ewalk','both') NOT NULL,
  code VARCHAR(8) NULL,                          -- 'A','B','C'
  name_en VARCHAR(80) NOT NULL,                  -- 'Escalator A · Pentacity'
  name_id VARCHAR(80) NOT NULL,                  -- 'Eskalator A · Pentacity'
  landmark_en VARCHAR(120) NULL,
  landmark_id VARCHAR(120) NULL,                 -- 'depan Sociolla'
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  schedule_id INT UNSIGNED NULL,
  notes TEXT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_bank_sched FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE SET NULL,
  CONSTRAINT fk_bank_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE connector_stops (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bank_id VARCHAR(48) NOT NULL,
  floor_id VARCHAR(32) NOT NULL,
  node_id INT UNSIGNED NOT NULL,
  public_id VARCHAR(64) NOT NULL UNIQUE,         -- id amenity di snapshot: 'esc-a-ewalk-gf-2'
  is_served TINYINT(1) NOT NULL DEFAULT 1,       -- lift berhenti di lantai ini?
  label_en VARCHAR(80) NULL,
  label_id VARCHAR(80) NULL,
  notes VARCHAR(255) NULL,
  UNIQUE KEY uq_stop (bank_id, node_id),
  KEY idx_stop_floor (floor_id),
  CONSTRAINT fk_stop_bank FOREIGN KEY (bank_id) REFERENCES connector_banks(id) ON DELETE CASCADE,
  CONSTRAINT fk_stop_floor FOREIGN KEY (floor_id) REFERENCES floors(id),
  CONSTRAINT fk_stop_node FOREIGN KEY (node_id) REFERENCES graph_nodes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE connector_legs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,    -- ruleKey ekspor: 'L<id>'
  bank_id VARCHAR(48) NOT NULL,
  lower_stop_id INT UNSIGNED NOT NULL,
  upper_stop_id INT UNSIGNED NOT NULL,
  direction ENUM('both','up','down') NOT NULL DEFAULT 'both',  -- up = lower->upper saja
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  schedule_id INT UNSIGNED NULL,                 -- null = ikut bank, lalu ikut mall
  cost_override DECIMAL(10,2) NULL,
  src_key VARCHAR(48) NULL,                      -- Mapplic endpoint 'esc-a-penta-2'
  verified_at DATETIME NULL,
  verified_by INT UNSIGNED NULL,
  field_note VARCHAR(255) NULL,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_leg_bank (bank_id),
  KEY idx_leg_lower (lower_stop_id),
  KEY idx_leg_upper (upper_stop_id),
  CONSTRAINT chk_leg_stops CHECK (lower_stop_id <> upper_stop_id),
  CONSTRAINT fk_leg_bank FOREIGN KEY (bank_id) REFERENCES connector_banks(id) ON DELETE CASCADE,
  CONSTRAINT fk_leg_lower FOREIGN KEY (lower_stop_id) REFERENCES connector_stops(id) ON DELETE CASCADE,
  CONSTRAINT fk_leg_upper FOREIGN KEY (upper_stop_id) REFERENCES connector_stops(id) ON DELETE CASCADE,
  CONSTRAINT fk_leg_sched FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE SET NULL,
  CONSTRAINT fk_leg_verifier FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_leg_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== categories, brands, tenants ==========
CREATE TABLE categories (
  id VARCHAR(48) PRIMARY KEY,
  name_en VARCHAR(80) NOT NULL,
  name_id VARCHAR(80) NOT NULL,
  icon VARCHAR(48) NOT NULL,
  color CHAR(7) NOT NULL DEFAULT '#857B70',
  sort_order SMALLINT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE brands (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  category_id VARCHAR(48) NOT NULL,
  logo_media_id INT UNSIGNED NULL,
  desc_en TEXT NULL,
  desc_id TEXT NULL,
  keywords_en VARCHAR(500) NULL,
  keywords_id VARCHAR(500) NULL,
  url VARCHAR(500) NULL,
  instagram VARCHAR(120) NULL,
  tiktok VARCHAR(120) NULL,
  facebook VARCHAR(255) NULL,
  whatsapp VARCHAR(32) NULL,                     -- E.164
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_brand_name (name),
  KEY idx_brand_cat (category_id),
  CONSTRAINT fk_brand_cat FOREIGN KEY (category_id) REFERENCES categories(id),
  CONSTRAINT fk_brand_logo FOREIGN KEY (logo_media_id) REFERENCES media(id) ON DELETE SET NULL,
  CONSTRAINT fk_brand_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tenants (
  id VARCHAR(64) PRIMARY KEY,                    -- slug publik stabil: 'uniqlo-gf'
  brand_id INT UNSIGNED NOT NULL,
  name_override VARCHAR(120) NULL,
  floor_id VARCHAR(32) NOT NULL,
  building ENUM('pentacity','ewalk') NOT NULL,
  unit_no VARCHAR(32) NULL,
  x DECIMAL(10,2) NULL,
  y DECIMAL(10,2) NULL,
  node_id INT UNSIGNED NULL,                     -- null = belum ditempatkan (tidak boleh publish bila is_published)
  unit_shape_id VARCHAR(128) NULL,
  phone VARCHAR(32) NULL,
  url_override VARCHAR(500) NULL,
  logo_override_media_id INT UNSIGNED NULL,
  status ENUM('open','coming_soon','temp_closed','closed') NOT NULL DEFAULT 'open',
  status_note_en VARCHAR(160) NULL,
  status_note_id VARCHAR(160) NULL,
  status_until DATE NULL,
  opening_date DATE NULL,
  hours_mode ENUM('mall','custom','24h','unknown') NOT NULL DEFAULT 'unknown',
  hours_note_en VARCHAR(160) NULL,
  hours_note_id VARCHAR(160) NULL,
  is_published TINYINT(1) NOT NULL DEFAULT 1,
  src_id VARCHAR(120) NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_tenant_brand (brand_id),
  KEY idx_tenant_floor (floor_id),
  KEY idx_tenant_status (status, is_published),
  CONSTRAINT fk_tenant_brand FOREIGN KEY (brand_id) REFERENCES brands(id),
  CONSTRAINT fk_tenant_floor FOREIGN KEY (floor_id) REFERENCES floors(id),
  CONSTRAINT fk_tenant_node FOREIGN KEY (node_id) REFERENCES graph_nodes(id) ON DELETE SET NULL,
  CONSTRAINT fk_tenant_logo FOREIGN KEY (logo_override_media_id) REFERENCES media(id) ON DELETE SET NULL,
  CONSTRAINT fk_tenant_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tenant_hours (
  tenant_id VARCHAR(64) NOT NULL,
  dow TINYINT UNSIGNED NOT NULL,                 -- 1=Senin … 7=Minggu
  open_time TIME NULL,
  close_time TIME NULL,
  is_closed TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, dow),
  CONSTRAINT fk_th_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT chk_th_dow CHECK (dow BETWEEN 1 AND 7)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== amenities (POI) ==========
CREATE TABLE amenity_types (
  id VARCHAR(32) PRIMARY KEY,                    -- 'toilet','musholla','atm','info-desk',...
  name_en VARCHAR(60) NOT NULL,
  name_id VARCHAR(60) NOT NULL,
  icon VARCHAR(48) NOT NULL,
  color CHAR(7) NOT NULL DEFAULT '#2F5BEA',
  show_in_home TINYINT(1) NOT NULL DEFAULT 0,
  sort_order SMALLINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE amenities (
  id VARCHAR(64) PRIMARY KEY,                    -- 'toilet-gf-penta-1'
  type_id VARCHAR(32) NOT NULL,
  floor_id VARCHAR(32) NOT NULL,
  building ENUM('pentacity','ewalk') NOT NULL,
  x DECIMAL(10,2) NOT NULL,
  y DECIMAL(10,2) NOT NULL,
  node_id INT UNSIGNED NULL,
  name_en VARCHAR(80) NULL,
  name_id VARCHAR(80) NULL,
  detail_en VARCHAR(160) NULL,
  detail_id VARCHAR(160) NULL,
  is_wheelchair TINYINT(1) NOT NULL DEFAULT 0,
  gender ENUM('all','male','female','family') NOT NULL DEFAULT 'all',
  schedule_id INT UNSIGNED NULL,
  is_published TINYINT(1) NOT NULL DEFAULT 1,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_am_floor (floor_id),
  KEY idx_am_type (type_id),
  CONSTRAINT fk_am_type FOREIGN KEY (type_id) REFERENCES amenity_types(id),
  CONSTRAINT fk_am_floor FOREIGN KEY (floor_id) REFERENCES floors(id),
  CONSTRAINT fk_am_node FOREIGN KEY (node_id) REFERENCES graph_nodes(id) ON DELETE SET NULL,
  CONSTRAINT fk_am_sched FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE SET NULL,
  CONSTRAINT fk_am_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== closures (status live) ==========
CREATE TABLE closures (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  leg_id INT UNSIGNED NULL,
  bank_id VARCHAR(48) NULL,
  edge_id INT UNSIGNED NULL,
  amenity_id VARCHAR(64) NULL,
  direction ENUM('both','up','down') NOT NULL DEFAULT 'both',
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NULL,                         -- null = sampai diakhiri manual
  reason_en VARCHAR(160) NULL,
  reason_id VARCHAR(160) NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_by INT UNSIGNED NULL,
  ended_at DATETIME NULL,                        -- diisi saat diakhiri manual (ends_at juga diset = ended_at)
  KEY idx_cl_active (ends_at, starts_at),
  CONSTRAINT chk_cl_target CHECK ((leg_id IS NOT NULL) + (bank_id IS NOT NULL) + (edge_id IS NOT NULL) + (amenity_id IS NOT NULL) = 1),
  CONSTRAINT fk_cl_leg FOREIGN KEY (leg_id) REFERENCES connector_legs(id) ON DELETE CASCADE,
  CONSTRAINT fk_cl_bank FOREIGN KEY (bank_id) REFERENCES connector_banks(id) ON DELETE CASCADE,
  CONSTRAINT fk_cl_edge FOREIGN KEY (edge_id) REFERENCES graph_edges(id) ON DELETE CASCADE,
  CONSTRAINT fk_cl_am FOREIGN KEY (amenity_id) REFERENCES amenities(id) ON DELETE CASCADE,
  CONSTRAINT fk_cl_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_cl_user2 FOREIGN KEY (ended_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notices (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  level ENUM('info','warning','emergency') NOT NULL,
  text_en VARCHAR(300) NOT NULL,
  text_id VARCHAR(300) NOT NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NULL,
  all_kiosks TINYINT(1) NOT NULL DEFAULT 1,
  kiosk_ids JSON NULL,                           -- ["gf-pentacity",...] bila all_kiosks=0
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notice_active (ends_at, starts_at),
  CONSTRAINT fk_notice_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== kiosks ==========
CREATE TABLE kiosks (
  id VARCHAR(48) PRIMARY KEY,                    -- 'gf-pentacity'
  name VARCHAR(80) NOT NULL,
  floor_id VARCHAR(32) NOT NULL,
  building ENUM('pentacity','ewalk') NOT NULL,
  x DECIMAL(10,2) NOT NULL,
  y DECIMAL(10,2) NOT NULL,
  node_id INT UNSIGNED NULL,
  facing_deg SMALLINT NULL,                      -- 0..359, relatif "atas" peta lantai
  default_lang ENUM('en','id') NOT NULL DEFAULT 'en',
  attract_lang ENUM('en','id') NOT NULL DEFAULT 'en',
  client_type ENUM('windows_pc','smart_tv','android_box','other') NOT NULL DEFAULT 'windows_pc',
  perf_mode ENUM('auto','full','lite') NOT NULL DEFAULT 'auto',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  token_hash CHAR(64) NULL,                      -- SHA-256(token); token plaintext hanya ditampilkan sekali
  token_hint CHAR(4) NULL,                       -- 4 char terakhir untuk identifikasi
  hw_note VARCHAR(255) NULL,                     -- merk/model/OS/resolusi/lokasi fisik
  src_id VARCHAR(64) NULL,
  -- runtime (diisi heartbeat)
  last_seen_at DATETIME NULL,
  ip_last VARCHAR(45) NULL,
  app_build VARCHAR(32) NULL,
  data_version VARCHAR(32) NULL,
  promos_version VARCHAR(32) NULL,
  status_version VARCHAR(32) NULL,
  user_agent VARCHAR(400) NULL,
  perf_active ENUM('full','lite') NULL,
  perf_reason VARCHAR(120) NULL,                 -- 'cms', 'auto:deviceMemory<=2', 'auto:fps', 'url'
  sw_active TINYINT(1) NULL,
  screen VARCHAR(40) NULL,                       -- '1920x1080@1'
  uptime_sec INT UNSIGNED NULL,
  last_error VARCHAR(500) NULL,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_kiosk_seen (last_seen_at),
  CONSTRAINT fk_kiosk_floor FOREIGN KEY (floor_id) REFERENCES floors(id),
  CONSTRAINT fk_kiosk_node FOREIGN KEY (node_id) REFERENCES graph_nodes(id) ON DELETE SET NULL,
  CONSTRAINT fk_kiosk_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE kiosk_commands (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kiosk_id VARCHAR(48) NOT NULL,
  command ENUM('reload','identify','clear_cache') NOT NULL,
  payload JSON NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at DATETIME NULL,
  acked_at DATETIME NULL,
  result VARCHAR(255) NULL,
  KEY idx_cmd_pending (kiosk_id, delivered_at),
  CONSTRAINT fk_cmd_kiosk FOREIGN KEY (kiosk_id) REFERENCES kiosks(id) ON DELETE CASCADE,
  CONSTRAINT fk_cmd_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE kiosk_heartbeats (                  -- satu baris per kiosk per menit; raw 30 hari
  kiosk_id VARCHAR(48) NOT NULL,
  minute DATETIME NOT NULL,                      -- dibulatkan ke menit
  perf_active ENUM('full','lite') NULL,
  PRIMARY KEY (kiosk_id, minute),
  CONSTRAINT fk_hb_kiosk FOREIGN KEY (kiosk_id) REFERENCES kiosks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== promos, events, featured, i18n ==========
CREATE TABLE promos (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title_en VARCHAR(120) NOT NULL,
  title_id VARCHAR(120) NOT NULL,
  sub_en VARCHAR(200) NULL,
  sub_id VARCHAR(200) NULL,
  kind ENUM('text','image','video') NOT NULL DEFAULT 'image',
  media_id INT UNSIGNED NULL,
  poster_media_id INT UNSIGNED NULL,
  bg_color CHAR(7) NULL,
  slot ENUM('attract-hero','attract-fullscreen','panel-banner','phone-arrival') NOT NULL DEFAULT 'attract-hero',
  link_type ENUM('none','tenant','category','event','url') NOT NULL DEFAULT 'none',
  link_ref VARCHAR(500) NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  days_mask TINYINT UNSIGNED NOT NULL DEFAULT 127,  -- bit0=Senin … bit6=Minggu
  time_from TIME NULL,
  time_to TIME NULL,
  duration_sec TINYINT UNSIGNED NOT NULL DEFAULT 8,
  weight TINYINT UNSIGNED NOT NULL DEFAULT 5,
  status ENUM('draft','active','paused','archived') NOT NULL DEFAULT 'draft',
  all_kiosks TINYINT(1) NOT NULL DEFAULT 1,
  advertiser_tenant_id VARCHAR(64) NULL,
  advertiser_name VARCHAR(120) NULL,
  max_impressions INT UNSIGNED NULL,
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_promo_window (status, starts_at, ends_at),
  CONSTRAINT chk_promo_weight CHECK (weight BETWEEN 1 AND 10),
  CONSTRAINT fk_promo_media FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE SET NULL,
  CONSTRAINT fk_promo_poster FOREIGN KEY (poster_media_id) REFERENCES media(id) ON DELETE SET NULL,
  CONSTRAINT fk_promo_adv FOREIGN KEY (advertiser_tenant_id) REFERENCES tenants(id) ON DELETE SET NULL,
  CONSTRAINT fk_promo_cb FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_promo_ub FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE promo_targets (
  promo_id INT UNSIGNED NOT NULL,
  kiosk_id VARCHAR(48) NOT NULL,
  PRIMARY KEY (promo_id, kiosk_id),
  CONSTRAINT fk_pt_promo FOREIGN KEY (promo_id) REFERENCES promos(id) ON DELETE CASCADE,
  CONSTRAINT fk_pt_kiosk FOREIGN KEY (kiosk_id) REFERENCES kiosks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE events (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title_en VARCHAR(120) NOT NULL,
  title_id VARCHAR(120) NOT NULL,
  desc_en TEXT NULL,
  desc_id TEXT NULL,
  media_id INT UNSIGNED NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  location_type ENUM('tenant','amenity','point','text') NOT NULL DEFAULT 'text',
  tenant_id VARCHAR(64) NULL,
  amenity_id VARCHAR(64) NULL,
  floor_id VARCHAR(32) NULL,
  x DECIMAL(10,2) NULL,
  y DECIMAL(10,2) NULL,
  node_id INT UNSIGNED NULL,
  location_text_en VARCHAR(160) NULL,
  location_text_id VARCHAR(160) NULL,
  show_on_attract TINYINT(1) NOT NULL DEFAULT 1,
  is_published TINYINT(1) NOT NULL DEFAULT 0,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_event_window (is_published, starts_at, ends_at),
  CONSTRAINT fk_ev_media FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE SET NULL,
  CONSTRAINT fk_ev_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL,
  CONSTRAINT fk_ev_am FOREIGN KEY (amenity_id) REFERENCES amenities(id) ON DELETE SET NULL,
  CONSTRAINT fk_ev_floor FOREIGN KEY (floor_id) REFERENCES floors(id) ON DELETE SET NULL,
  CONSTRAINT fk_ev_node FOREIGN KEY (node_id) REFERENCES graph_nodes(id) ON DELETE SET NULL,
  CONSTRAINT fk_ev_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE featured_tenants (
  tenant_id VARCHAR(64) PRIMARY KEY,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  starts_at DATETIME NULL,
  ends_at DATETIME NULL,
  CONSTRAINT fk_ft_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE i18n_strings (
  `key` VARCHAR(64) PRIMARY KEY,                 -- sama dengan key di js/i18n.js
  en VARCHAR(500) NULL,
  id VARCHAR(500) NULL,
  note VARCHAR(160) NULL,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_i18n_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== publish ==========
CREATE TABLE releases (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  channel ENUM('directory','promos','status') NOT NULL,
  version VARCHAR(32) NOT NULL,                  -- 'D0042-202610051530'
  seq INT UNSIGNED NOT NULL,
  sha256 CHAR(64) NOT NULL,
  bytes INT UNSIGNED NOT NULL,
  path VARCHAR(255) NOT NULL,                    -- 'data/releases/D0042-202610051530/directory.json'
  revs JSON NULL,                                -- {"content":12,"map":7,"promos":3} saat publish
  stats JSON NULL,
  diff JSON NULL,
  validation JSON NULL,
  notes VARCHAR(500) NULL,
  is_live TINYINT(1) NOT NULL DEFAULT 0,
  rolled_back_from INT UNSIGNED NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rel (channel, version),
  UNIQUE KEY uq_rel_seq (channel, seq),
  KEY idx_rel_live (channel, is_live),
  CONSTRAINT fk_rel_rb FOREIGN KEY (rolled_back_from) REFERENCES releases(id) ON DELETE SET NULL,
  CONSTRAINT fk_rel_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE validation_runs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ok TINYINT(1) NOT NULL,
  errors SMALLINT UNSIGNED NOT NULL,
  warnings SMALLINT UNSIGNED NOT NULL,
  report JSON NOT NULL,
  revs JSON NULL,
  ms INT UNSIGNED NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_vr_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== audit & analytics ==========
CREATE TABLE audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id INT UNSIGNED NULL,
  ip VARCHAR(45) NULL,
  action VARCHAR(40) NOT NULL,                   -- 'create','update','delete','publish','rollback','login','login_fail','closure_start',...
  entity_type VARCHAR(40) NOT NULL,
  entity_id VARCHAR(64) NULL,
  summary VARCHAR(255) NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  KEY idx_audit_entity (entity_type, entity_id),
  KEY idx_audit_ts (ts),
  KEY idx_audit_user (user_id, ts),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE telemetry_events (                  -- raw, retensi 180 hari (tanpa FK agar ingest cepat)
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  source ENUM('kiosk','phone') NOT NULL,
  kiosk_id VARCHAR(48) NULL,
  session_id CHAR(12) NULL,
  ts DATETIME(3) NOT NULL,                       -- waktu klien (WITA)
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  type VARCHAR(32) NOT NULL,
  tenant_id VARCHAR(64) NULL,
  promo_id INT UNSIGNED NULL,
  query VARCHAR(100) NULL,
  value INT NULL,                                -- jumlah hasil, durasi ms, dll.
  lang CHAR(2) NULL,
  `accessible` TINYINT(1) NULL,              -- backtick: ACCESSIBLE adalah reserved word MariaDB
  ip_hash CHAR(16) NULL,
  payload JSON NULL,
  KEY idx_te_type_ts (type, ts),
  KEY idx_te_kiosk_ts (kiosk_id, ts),
  KEY idx_te_tenant_ts (tenant_id, ts),
  KEY idx_te_promo_ts (promo_id, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stats_daily (
  day DATE NOT NULL,
  kiosk_id VARCHAR(48) NOT NULL DEFAULT '*',
  metric VARCHAR(32) NOT NULL,                   -- 'search','search_zero','tenant_view','route','route_acc','qr_shown','qr_scan','nav_arrived','promo_imp','promo_tap','session','uptime_min'
  dim VARCHAR(100) NOT NULL DEFAULT '',          -- tenant_id / query / promo_id / ''
  value INT UNSIGNED NOT NULL,
  PRIMARY KEY (day, kiosk_id, metric, dim),
  KEY idx_sd_metric (metric, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

INSERT INTO revisions (scope, rev) VALUES ('content',0),('map',0),('promos',0);
