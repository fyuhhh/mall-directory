-- BSB Directory — migrasi Oktober 2026 (peta 3D, docs/3D.md). Aman dijalankan ulang.

-- 1. Ruas jalur bertipe tangga: tetap jalan kaki, tapi dilewati mode kursi roda (route.js / RouteCheck membuang 'stairs').
--    Sebelumnya hanya 'walk', sehingga tangga GF E-Walk (perbaikan D0034 yang diedit tangan di directory.json) hilang saat publish.
ALTER TABLE graph_edges MODIFY type ENUM('walk','stairs') NOT NULL DEFAULT 'walk';

-- 2. Tangga GF E-Walk (perbaikan rute Captain Gelato & Tea Break, D0034).
UPDATE graph_edges SET type='stairs' WHERE (node_a=209 AND node_b=225) OR (node_a=225 AND node_b=226);
