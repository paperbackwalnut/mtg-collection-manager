CREATE TABLE `card_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deck_card_id` integer NOT NULL,
	`deck_id` integer NOT NULL,
	`card_name` text NOT NULL,
	`collection_id` integer,
	`proxy_inventory_id` integer,
	`proxy_set_code` text,
	`proxy_collector_number` text,
	`status` text DEFAULT 'unassigned' NOT NULL,
	`pulled` integer DEFAULT false NOT NULL,
	`note` text,
	`print_status` text,
	FOREIGN KEY (`deck_card_id`) REFERENCES `deck_cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `collection`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proxy_inventory_id`) REFERENCES `proxy_inventory`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ca_deck_idx` ON `card_assignments` (`deck_id`);--> statement-breakpoint
CREATE INDEX `ca_coll_idx` ON `card_assignments` (`collection_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ca_proxy_inventory_unique` ON `card_assignments` (`proxy_inventory_id`);--> statement-breakpoint
CREATE TABLE `collection` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scryfall_id` text,
	`oracle_id` text,
	`name` text NOT NULL,
	`set_code` text NOT NULL,
	`collector_number` text NOT NULL,
	`condition` text DEFAULT 'NM',
	`language` text DEFAULT 'English',
	`foil` integer DEFAULT false,
	`quantity` integer DEFAULT 1 NOT NULL,
	`purchase_price` real,
	`location_override` text,
	`tags` text
);
--> statement-breakpoint
CREATE INDEX `coll_name_idx` ON `collection` (`name`);--> statement-breakpoint
CREATE INDEX `coll_oracle_idx` ON `collection` (`oracle_id`);--> statement-breakpoint
CREATE TABLE `deck_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deck_id` integer NOT NULL,
	`card_name` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`set_code` text,
	`collector_number` text,
	`board` text DEFAULT 'main',
	`is_commander` integer DEFAULT false,
	`notes` text,
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dc_deck_idx` ON `deck_cards` (`deck_id`);--> statement-breakpoint
CREATE TABLE `deck_pending_removals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deck_id` integer NOT NULL,
	`deck_card_id` integer NOT NULL,
	`card_name` text NOT NULL,
	`board` text DEFAULT 'main' NOT NULL,
	`target_quantity` integer NOT NULL,
	`detected_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deck_card_id`) REFERENCES `deck_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dpr_deck_idx` ON `deck_pending_removals` (`deck_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dpr_deck_card_unique` ON `deck_pending_removals` (`deck_card_id`);--> statement-breakpoint
CREATE TABLE `deck_pending_return_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pending_removal_id` integer NOT NULL,
	`assignment_id` integer NOT NULL,
	`detected_at` integer NOT NULL,
	FOREIGN KEY (`pending_removal_id`) REFERENCES `deck_pending_removals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignment_id`) REFERENCES `card_assignments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dpra_pending_idx` ON `deck_pending_return_assignments` (`pending_removal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dpra_assignment_unique` ON `deck_pending_return_assignments` (`assignment_id`);--> statement-breakpoint
CREATE TABLE `deck_sync_additions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deck_id` integer NOT NULL,
	`deck_card_id` integer NOT NULL,
	`card_name` text NOT NULL,
	`board` text DEFAULT 'main' NOT NULL,
	`quantity` integer NOT NULL,
	`detected_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deck_card_id`) REFERENCES `deck_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dsa_deck_idx` ON `deck_sync_additions` (`deck_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dsa_deck_card_unique` ON `deck_sync_additions` (`deck_card_id`);--> statement-breakpoint
CREATE TABLE `decks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`format` text,
	`commander` text,
	`moxfield_url` text,
	`source_mode` text DEFAULT 'local' NOT NULL,
	`last_sync_attempted_at` integer,
	`last_synced_at` integer,
	`last_sync_status` text,
	`last_sync_error` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_name` text NOT NULL,
	`set_code` text,
	`collector_number` text,
	`quantity` integer DEFAULT 1 NOT NULL,
	`source` text DEFAULT 'other' NOT NULL,
	`notes` text,
	`status` text DEFAULT 'ordered' NOT NULL,
	`ordered_at` integer NOT NULL,
	`arrived_at` integer
);
--> statement-breakpoint
CREATE TABLE `proxy_inventory` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_name` text NOT NULL,
	`oracle_id` text,
	`scryfall_id` text,
	`set_code` text,
	`collector_number` text,
	`location` text DEFAULT 'proxy_box' NOT NULL,
	`print_state` text DEFAULT 'ready' NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pi_card_name_idx` ON `proxy_inventory` (`card_name`);--> statement-breakpoint
CREATE INDEX `pi_oracle_idx` ON `proxy_inventory` (`oracle_id`);--> statement-breakpoint
CREATE INDEX `pi_scryfall_idx` ON `proxy_inventory` (`scryfall_id`);--> statement-breakpoint
CREATE INDEX `pi_location_idx` ON `proxy_inventory` (`location`);--> statement-breakpoint
CREATE TABLE `shopping_list` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_name` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`notes` text,
	`source` text,
	`added_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sl_card_name_unique` ON `shopping_list` (`card_name`);