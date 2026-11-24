-- Split "the home internet line" from "services behind it".
-- Run once against an existing DB:
--   npx wrangler d1 execute status-db --remote --file migrations/0001_internet_vs_services.sql
ALTER TABLE monitors ADD COLUMN grp TEXT NOT NULL DEFAULT 'service';
ALTER TABLE monitors ADD COLUMN display TEXT;
ALTER TABLE incidents ADD COLUMN silent INTEGER NOT NULL DEFAULT 0;

-- The old "Home Network" monitor was really an HTTP check of the torrent app
-- through the Cloudflare tunnel: keep its history, but call it what it is.
UPDATE monitors SET name = 'Torrent', grp = 'service' WHERE id = 'home-network';
