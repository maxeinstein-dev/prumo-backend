-- P21 L6: XP notifications that no reader understands are kept "em estudo" for 60 days, outside the box of captures.
-- Additive: one new value of an existing enum; no row and no other migration changes. The value is not used here.
ALTER TYPE "CaptureStatus" ADD VALUE 'STUDY';
