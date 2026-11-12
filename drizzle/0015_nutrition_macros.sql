-- Add columns without rebuilding the table, preserving nutrition audit/completeness triggers.
ALTER TABLE `nutrition_entries` ADD `carbs_tenth` integer CONSTRAINT `nutrition_entries_carbs_bounds` CHECK (`carbs_tenth` IS NULL OR (typeof(`carbs_tenth`) = 'integer' AND `carbs_tenth` BETWEEN 0 AND 200000));
--> statement-breakpoint
ALTER TABLE `nutrition_entries` ADD `protein_tenth` integer CONSTRAINT `nutrition_entries_protein_bounds` CHECK (`protein_tenth` IS NULL OR (typeof(`protein_tenth`) = 'integer' AND `protein_tenth` BETWEEN 0 AND 200000));
--> statement-breakpoint
ALTER TABLE `nutrition_entries` ADD `fat_tenth` integer CONSTRAINT `nutrition_entries_fat_bounds` CHECK (`fat_tenth` IS NULL OR (typeof(`fat_tenth`) = 'integer' AND `fat_tenth` BETWEEN 0 AND 200000));
