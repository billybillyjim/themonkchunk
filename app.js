let vm = Vue.createApp({
	data() {
		return {
			bounds: {
				minX: 3008,
				maxX: 3071,
				minY: 3456,
				maxY: 3519
			},
			events: [],
			knownEventNames: [],
			isLoading: true,
			loadError: "",
			selectedIndex: 0,
			cursorTile: null,
			showHistory: true,
			isPlaying: false,
			playbackFrame: null,
			playbackStartedAt: 0,
			playbackStartedIndex: 0,
			playbackSpeed: 120,
			playbackSpeeds: [1, 5, 15, 30, 60, 120, 240],
			chanceDenominator: 46,
			oddsOfAny:23,
			timelineWindowSize: 100,
			analyticsSortKey: "currentDry",
			analyticsSortDirection: "desc",
			lastModified:null,
			activeTab: new URLSearchParams(window.location.search).get("tab") == "profile" ? "profile" : "events",
			profileEntries: [],
			profileChanges: [],
			profileBaselineAt: "",
			profileUpdatedAt: "",
			profilePeriod: "today",
			profileLoading: false,
			profileLoaded: false,
			profileError: "",
			profileSearch: "",
			profilePlugin: "all",
			lootManifest: { items: {}, npcs: {} },
		};
	},
	delimiters: ["[[", "]]"],
	computed: {
		profilePlugins() {
			return [...new Set([...this.profileEntries, ...this.profileChanges].map(entry => entry.plugin))].sort((a, b) => this.profileDisplayName(a).localeCompare(this.profileDisplayName(b)));
		},
		profileProgress() {
			const now = new Date();
			let start = null;
			if (this.profilePeriod == "today") start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			if (this.profilePeriod == "week") {
				start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
				start.setDate(start.getDate() - (start.getDay() + 6) % 7);
			}
			if (this.profilePeriod == "month") start = new Date(now.getFullYear(), now.getMonth(), 1);
			const grouped = new Map();
			for (const change of this.profileChanges) {
				if (start && new Date(change.at) < start) continue;
				const id = JSON.stringify([change.plugin, change.key]);
				if (!grouped.has(id)) grouped.set(id, { ...change, count: 1 });
				else {
					const item = grouped.get(id);
					item.after = change.after;
					item.at = change.at;
					item.count += 1;
				}
			}
			const query = this.profileSearch.trim().toLocaleLowerCase();
			return [...grouped.values()].filter(change =>
				change.before !== change.after &&
				(this.profilePlugin == "all" || change.plugin == this.profilePlugin) &&
				(!query || `${change.plugin} ${change.key} ${change.before ?? ""} ${change.after ?? ""}`.toLocaleLowerCase().includes(query))
			).sort((a, b) => new Date(b.at) - new Date(a.at) || a.plugin.localeCompare(b.plugin) || a.key.localeCompare(b.key));
		},
		filteredProfileEntries() {
			const query = this.profileSearch.trim().toLocaleLowerCase();
			return this.profileEntries.filter(entry =>
				(this.profilePlugin == "all" || entry.plugin == this.profilePlugin) &&
				(!query || `${entry.plugin} ${entry.key} ${entry.value}`.toLocaleLowerCase().includes(query))
			);
		},
		profileProgressGroups() {
			return this.groupProfileItems(this.profileProgress.map(change => ({
				...change,
				loot: this.parseLoot(change.after ?? change.before),
				previousLoot: this.parseLoot(change.before),
				parsed: ["xpTracker", "wealthtracker"].includes(change.plugin) ? this.parseProfileJson(change.after ?? change.before) : null,
				previousParsed: ["xpTracker", "wealthtracker"].includes(change.plugin) ? this.parseProfileJson(change.before) : null
			})));
		},
		profileSnapshotGroups() {
			return this.groupProfileItems(this.filteredProfileEntries.map(entry => ({
				...entry,
				loot: this.parseLoot(entry.value),
				parsed: ["xpTracker", "wealthtracker"].includes(entry.plugin) ? this.parseProfileJson(entry.value) : null
			})));
		},
		selectedEvent() {
			return this.events[this.selectedIndex] || null;
		},
		visibleMarkers() {
			if (this.events.length == 0) {
				return [];
			}

			let firstVisibleIndex = this.showHistory ? 0 : this.selectedIndex;
			let lastVisibleIndex = this.selectedIndex;
			let markers = [];

			for (let index = firstVisibleIndex; index <= lastVisibleIndex; index += 1) {
				let event = this.events[index];
				let npc = event.npcInfoRecord;

				if (!npc) {
					continue;
				}

				markers.push({
					key: "event-" + event.spawnedTime + "-" + index,
					eventIndex: index,
					name: npc.npcName || "Unknown event",
					x: npc.worldX,
					y: npc.worldY
				});
			}

			return markers;
		},
		xpDelta() {
			if (!this.selectedEvent || this.selectedIndex == 0) {
				return 0;
			}

			let currentXp = this.selectedEvent.xpInfoRecord?.overallExperience || 0;
			let previousXp = this.events[this.selectedIndex - 1].xpInfoRecord?.overallExperience || 0;
			return currentXp - previousXp;
		},
		timelineWindow() {
			if (this.events.length == 0) {
				return [];
			}

			let size = Math.min(this.timelineWindowSize, this.events.length);
			let half = Math.floor(size / 2);
			let start = Math.max(0, this.selectedIndex - half);
			let end = Math.min(this.events.length, start + size);
			start = Math.max(0, end - size);
			let items = [];

			for (let index = start; index < end; index += 1) {
				items.push({
					event: this.events[index],
					index: index
				});
			}

			return items;
		},
		eventStats() {
			let total = this.events.length;
			let eventIndexes = new Map();

			for (let index = 0; index < total; index += 1) {
				let name = this.events[index].npcInfoRecord?.npcName || "Unknown event";

				if (!eventIndexes.has(name)) {
					eventIndexes.set(name, []);
				}

				eventIndexes.get(name).push(index);
			}

			for (let knownName of this.knownEventNames) {
				if (!eventIndexes.has(knownName)) {
					eventIndexes.set(knownName, []);
				}
			}

			let expected = total / this.oddsOfAny;
			let stats = [];

			for (let entry of eventIndexes.entries()) {
				let name = entry[0];
				let indexes = entry[1];
				let gapsBetween = [];

				for (let occurrenceIndex = 1; occurrenceIndex < indexes.length; occurrenceIndex += 1) {
					gapsBetween.push(indexes[occurrenceIndex] - indexes[occurrenceIndex - 1] - 1);
				}

				let count = indexes.length;
				let leadingDry = count > 0 ? indexes[0] : total;
				let currentDry = count > 0 ? total - indexes[indexes.length - 1] - 1 : total;
				let longestBetween = gapsBetween.length > 0 ? Math.max(...gapsBetween) : null;
				let allDryRuns = [leadingDry, currentDry].concat(gapsBetween);
				let longestDry = allDryRuns.length > 0 ? Math.max(...allDryRuns) : 0;
				let noHitProbability = Math.pow(
					(this.oddsOfAny - 1) / this.oddsOfAny,
					currentDry
				);

				stats.push({
					name: name,
					count: count,
					expected: expected,
					difference: count - expected,
					leadingDry: leadingDry,
					currentDry: currentDry,
					longestBetween: longestBetween,
					longestDry: longestDry,
					lastSeenEvent: count > 0 ? indexes[indexes.length - 1] + 1 : null,
					dryMultiplier: currentDry / this.oddsOfAny,
					noHitProbability: noHitProbability,
					isDryNow: currentDry >= this.chanceDenominator,
					isVeryDryNow: currentDry >= this.chanceDenominator * 2,
					isUnderExpected: count < expected
				});
			}
			
			let sortKey = this.analyticsSortKey;
			let direction = this.analyticsSortDirection == "asc" ? 1 : -1;

			stats.sort((first, second) => {
				let firstValue = first[sortKey];
				let secondValue = second[sortKey];
				let comparison = 0;

				if (typeof firstValue == "string") {
					comparison = firstValue.localeCompare(secondValue);
				} else {
					comparison = firstValue - secondValue;
				}

				if (comparison != 0) {
					return comparison * direction;
				}

				if (sortKey == "currentDry" && first.longestDry != second.longestDry) {
					return (first.longestDry - second.longestDry) * direction;
				}

				return first.name.localeCompare(second.name);
			});

			return stats;
		},
		dryNowStats() {
			return this.eventStats.filter((stat) => stat.isDryNow);
		},
		underExpectedStats() {
			return this.eventStats.filter((stat) => stat.isUnderExpected);
		}
	},
	mounted() {
		window.addEventListener("keydown", this.handleKeyboard);
		this.loadEvents();
		if (this.activeTab == "profile") this.loadProfile();
	},
	beforeUnmount() {
		window.removeEventListener("keydown", this.handleKeyboard);
		this.stopPlayback();
	},
	methods: {
		selectTab(tab) {
			this.activeTab = tab;
			const url = new URL(window.location.href);
			if (tab == "profile") url.searchParams.set("tab", "profile");
			else url.searchParams.delete("tab");
			window.history.replaceState(null, "", url);
			if (tab == "profile" && !this.profileLoaded && !this.profileLoading) {
				this.loadProfile();
			}
			if (tab != "events") this.stopPlayback();
		},
		async loadProfile() {
			this.profileLoading = true;
			this.profileError = "";
			try {
				const response = await fetch("profile_info.json?ts=" + Date.now(), { cache: "no-store" });
				if (!response.ok) throw new Error("HTTP " + response.status + " while loading profile_info.json");
				const data = await response.json();
				if (data.profile !== "OXNNqtET" || !Array.isArray(data.entries) || !Array.isArray(data.changes)) {
					throw new Error("profile_info.json has an unexpected format");
				}
				this.profileEntries = data.entries;
				this.profileChanges = data.changes;
				this.profileBaselineAt = data.baselineAt;
				this.profileUpdatedAt = data.updatedAt;
				try {
					const manifestResponse = await fetch("images/manifest.json?ts=" + Date.now(), { cache: "no-store" });
					if (manifestResponse.ok) this.lootManifest = await manifestResponse.json();
				} catch (manifestError) {
					console.warn("Loot images manifest unavailable", manifestError);
				}
				this.profileLoaded = true;
			} catch (error) {
				console.error(error);
				this.profileError = error instanceof Error ? error.message : String(error);
			} finally {
				this.profileLoading = false;
			}
		},
		groupProfileItems(items) {
			const groups = new Map();
			for (const item of items) {
				if (!groups.has(item.plugin)) groups.set(item.plugin, []);
				groups.get(item.plugin).push(item);
			}
			return [...groups].sort(([a], [b]) => this.profileDisplayName(a).localeCompare(this.profileDisplayName(b))).map(([plugin, entries]) => ({ plugin, entries }));
		},
		profileDisplayName(plugin) {
			const names = {
				WeaponAnimationReplacer: "Weapon Animation Replacer",
				itemCharge: "Item Charges",
				loottracker: "Loot Tracker",
				osrstcg: "OSRS TCG",
				questhelper: "Quest Helper",
				randomeventanalytics: "Random Event Analytics",
				rsprofile: "RuneLite Profile",
				slayer: "Slayer",
				"tasks-tracker": "Tasks Tracker",
				timetracking: "Time Tracking",
				transmog: "Transmog",
				ultimatestattracker: "Ultimate Stat Tracker",
				wealthtracker: "Wealth Tracker",
				xpTracker: "XP Tracker (I usually reset this at the beginning of any given day)"
			};
			return names[plugin] || plugin.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ");
		},
		profileEntryLabel(plugin, key) {
			if (plugin != "ultimatestattracker") return key;
			return key.replace(/date$/i, "Date")
				.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
				.replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
				.replace(/_/g, " ")
				.replace(/^./, first => first.toUpperCase());
		},
		parseProfileJson(value) {
			if (value == null) return null;
			try { return JSON.parse(value); } catch { return null; }
		},
		parseLoot(value) {
			if (!value) return null;
			try {
				const loot = JSON.parse(value);
				if (!loot || !Array.isArray(loot.drops) || !loot.name) return null;
				return {
					...loot,
					items: Array.from({ length: Math.floor(loot.drops.length / 2) }, (_, index) => ({
						id: loot.drops[index * 2],
						count: loot.drops[index * 2 + 1]
					}))
				};
			} catch {
				return null;
			}
		},
		profileDelta(change) {
			if (change.before == null || change.after == null) return "";
			const numeric = /^-?(?:\d+\.?\d*|\.\d+)$/;
			if (!numeric.test(change.before) || !numeric.test(change.after)) return "";
			const difference = Number(change.after) - Number(change.before);
			if (!Number.isFinite(difference) || difference == 0) return "";
			return (difference > 0 ? "+" : "") + difference.toLocaleString();
		},
		ultimateStatDelta(change) {
			const current = Number(change.after);
			const previous = change.before == null ? 0 : Number(change.before);
			return Number.isFinite(current) && Number.isFinite(previous) ? current - previous : null;
		},
		profileChangeLabel(change) {
			if (change.before == null) return "Added";
			if (change.after == null) return "Removed";
			return this.profileDelta(change) || "Changed";
		},
		sortAnalytics(sortKey) {
			if (this.analyticsSortKey == sortKey) {
				this.analyticsSortDirection = this.analyticsSortDirection == "asc" ? "desc" : "asc";
				return;
			}

			this.analyticsSortKey = sortKey;
			this.analyticsSortDirection = sortKey == "name" ? "asc" : "desc";
		},
		analyticsSortAria(sortKey) {
			if (this.analyticsSortKey != sortKey) {
				return "none";
			}

			return this.analyticsSortDirection == "asc" ? "ascending" : "descending";
		},
		analyticsSortIndicator(sortKey) {
			if (this.analyticsSortKey != sortKey) {
				return "";
			}

			return this.analyticsSortDirection == "asc" ? "▲" : "▼";
		},
		normalizeRandomEvent(event) {
			const certerNames = new Set(["Miles", "Giles", "Niles"]);
			const mysteriousOldManNamesByNpcId = new Map([
				[6752, "Maze"],
				[6753, "Mime"],
				[6750, "Mysterious Old Man"]
			]);
			const prisonPeteId = 6754;
			const npcInfoRecord = event?.npcInfoRecord;

			if (!npcInfoRecord) {
				return event;
			}

			const npcName = npcInfoRecord.npcName;
			const normalizedNpcName = mysteriousOldManNamesByNpcId.get(Number(npcInfoRecord.npcId));
			if(npcName == "Evil Bob" && npcInfoRecord.npcId == prisonPeteId){
				return {
					...event,
					npcInfoRecord: {
						...npcInfoRecord,
						originalNpcName: npcName,
						npcName: "Prison Pete"
					}
				};
			}
			if (npcName == "Mysterious Old Man" && normalizedNpcName) {
				return {
					...event,
					npcInfoRecord: {
						...npcInfoRecord,
						originalNpcName: npcName,
						npcName: normalizedNpcName
					}
				};
			}

			if (certerNames.has(npcName)) {
				return {
					...event,
					npcInfoRecord: {
						...npcInfoRecord,
						originalNpcName: npcName,
						npcName: "Certer"
					}
				};
			}

			return event;
		},
		async loadEvents() {
			this.stopPlayback();
			this.isLoading = true;
			this.loadError = "";

			try {
				let response = await fetch("random-events.log?ts=" + Date.now(), { cache: "no-store" });

				if (!response.ok) {
					throw new Error("HTTP " + response.status + " while loading random-events.log");
				}

				let logText = await response.text();
				let parsedEvents = this.parseEventLog(logText).map((event) => this.normalizeRandomEvent(event)).sort((a, b) => a.spawnedTime - b.spawnedTime);

				this.events = parsedEvents;
				this.selectedIndex = parsedEvents.length - 1;
				this.lastModified = this.formatDate(this.events[this.events.length - 1].spawnedTime);

			} catch (error) {
				console.error(error);
				this.events = [];
				this.selectedIndex = 0;
				this.loadError = error instanceof Error ? error.message : String(error);
			} finally {
				this.isLoading = false;
			}
		},
		parseEventLog(logText) {
			return logText.trim().split(/\r?\n/).map(line => JSON.parse(line));
		},
		markerStyle(marker) {
			let tileWidth = this.bounds.maxX - this.bounds.minX + 1;
			let tileHeight = this.bounds.maxY - this.bounds.minY + 1;
			let leftPercent = ((marker.x - this.bounds.minX + 0.5) / tileWidth) * 100;
			let topPercent = ((this.bounds.maxY - marker.y + 0.5) / tileHeight) * 100;

			return {
				left: leftPercent + "%",
				top: topPercent + "%",
				zIndex: marker.eventIndex == this.selectedIndex ? 100000 : marker.eventIndex + 10
			};
		},
		updateCursorTile(mouseEvent) {
			let rect = this.$refs.mapStage.getBoundingClientRect();
			let xRatio = (mouseEvent.clientX - rect.left) / rect.width;
			let yRatio = (mouseEvent.clientY - rect.top) / rect.height;
			let tileWidth = this.bounds.maxX - this.bounds.minX + 1;
			let tileHeight = this.bounds.maxY - this.bounds.minY + 1;
			let worldX = this.bounds.minX + Math.floor(xRatio * tileWidth);
			let worldY = this.bounds.maxY - Math.floor(yRatio * tileHeight);

			worldX = Math.min(this.bounds.maxX, Math.max(this.bounds.minX, worldX));
			worldY = Math.min(this.bounds.maxY, Math.max(this.bounds.minY, worldY));
			this.cursorTile = { x: worldX, y: worldY };
		},
		selectEvent(index) {
			this.stopPlayback();
			this.selectedIndex = index;
		},
		previousEvent() {
			this.stopPlayback();

			if (this.selectedIndex > 0) {
				this.selectedIndex -= 1;
			}
		},
		nextEvent() {
			this.stopPlayback();

			if (this.selectedIndex < this.events.length - 1) {
				this.selectedIndex += 1;
			}
		},
		togglePlayback() {
			if (this.events.length == 0) {
				return;
			}

			if (this.isPlaying) {
				this.stopPlayback();
				return;
			}

			if (this.selectedIndex == this.events.length - 1) {
				this.selectedIndex = 0;
			}

			this.startPlayback();
		},
		startPlayback() {
			this.isPlaying = true;
			this.playbackStartedAt = performance.now();
			this.playbackStartedIndex = this.selectedIndex;

			let advance = (now) => {
				if (!this.isPlaying) {
					return;
				}

				let elapsedSeconds = (now - this.playbackStartedAt) / 1000;
				let targetIndex = this.playbackStartedIndex +
					Math.floor(elapsedSeconds * this.playbackSpeed);
				targetIndex = Math.min(this.events.length - 1, targetIndex);

				if (targetIndex != this.selectedIndex) {
					this.selectedIndex = targetIndex;
				}

				if (this.selectedIndex >= this.events.length - 1) {
					this.stopPlayback();
					return;
				}

				this.playbackFrame = window.requestAnimationFrame(advance);
			};

			this.playbackFrame = window.requestAnimationFrame(advance);
		},
		changePlaybackSpeed() {
			if (!this.isPlaying) {
				return;
			}

			this.stopPlayback();
			this.startPlayback();
		},
		stopPlayback() {
			this.isPlaying = false;

			if (this.playbackFrame != null) {
				window.cancelAnimationFrame(this.playbackFrame);
				this.playbackFrame = null;
			}
		},
		handleKeyboard(keyboardEvent) {
			if (this.activeTab != "events") return;
			if (keyboardEvent.target.matches && keyboardEvent.target.matches("input, button, textarea, select")) {
				return;
			}

			if (keyboardEvent.key == "ArrowLeft") {
				this.previousEvent();
			}

			if (keyboardEvent.key == "ArrowRight") {
				this.nextEvent();
			}

			if (keyboardEvent.key == " ") {
				keyboardEvent.preventDefault();
				this.togglePlayback();
			}
		},
		formatDate(timestamp) {
			return new Intl.DateTimeFormat(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				timeZoneName: "short"
			}).format(new Date(timestamp));
		},
		formatDuration(totalSeconds) {
			let hours = Math.floor(totalSeconds / 3600);
			let minutes = Math.floor((totalSeconds % 3600) / 60);
			let seconds = totalSeconds % 60;
			let parts = [];

			if (hours > 0) {
				parts.push(hours + "h");
			}

			if (minutes > 0 || hours > 0) {
				parts.push(minutes + "m");
			}

			parts.push(seconds + "s");
			return parts.join(" ");
		},
		formatExpected(value) {
			return value.toLocaleString(undefined, {
				minimumFractionDigits: 1,
				maximumFractionDigits: 1
			});
		},
		formatSigned(value) {
			let rounded = value.toLocaleString(undefined, {
				minimumFractionDigits: 1,
				maximumFractionDigits: 1,
				signDisplay: "always"
			});

			return rounded;
		},
		formatPercent(value) {
			return new Intl.NumberFormat(undefined, {
				style: "percent",
				minimumFractionDigits: value < 0.01 ? 2 : 1,
				maximumFractionDigits: value < 0.01 ? 2 : 1
			}).format(value);
		},
		dryLabel(stat) {
			if (stat.isVeryDryNow) {
				return "Very dry";
			}

			if (stat.isDryNow) {
				return "Dry now";
			}

			return "Not dry";
		}
	}
}).component("loot-card", {
	props: ["loot", "previous", "manifest", "removed"],
	template: "#loot-card-template",
	delimiters: ["[[", "]]"],
	computed: {
		previousCounts() {
			return new Map((this.previous?.items || []).map(item => [item.id, Number(item.count)]));
		},
		displayItems() {
			const items = [...this.loot.items];
			const currentIds = new Set(items.map(item => item.id));
			for (const item of this.previous?.items || []) {
				if (!currentIds.has(item.id)) items.push({ id: item.id, count: 0 });
			}
			return items.sort((a, b) => Number(b.count) - Number(a.count));
		},
		killDelta() {
			if (!this.previous || this.removed) return null;
			return Number(this.loot.kills) - Number(this.previous.kills);
		},
		countLabel() {
			if (/\bimpling\b/i.test(this.loot.name)) return "caught";
			return this.loot.type == "NPC" ? "kills" : "opens";
		}
	},
	methods: {
		formatLootDate(timestamp) {
			if (!timestamp) return "Unknown";
			return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
		},
		itemDelta(item) {
			if (!this.previous || this.removed) return null;
			return Number(item.count) - (this.previousCounts.get(item.id) || 0);
		}
	}
}).component("xp-tracker-table", {
	props: ["state"],
	template: "#xp-tracker-table-template",
	delimiters: ["[[", "]]"],
	computed: {
		rows() {
			if (!this.state || typeof this.state !== "object") return [];
			const makeRow = (name, record) => {
				const start = Number(record?.s) || 0;
				const gained = (Number(record?.br) || 0) + (Number(record?.ar) || 0);
				return { name, start, gained, current: start + gained, time: Number(record?.t) || 0 };
			};
			const rows = [];
			if (this.state.overall) rows.push(makeRow("Overall", this.state.overall));
			for (const [skill, record] of Object.entries(this.state.skills || {})) {
				rows.push(makeRow(skill.charAt(0) + skill.slice(1).toLowerCase(), record));
			}
			return rows;
		}
	},
	methods: {
		formatTrackedTime(milliseconds) {
			const minutes = Math.floor(milliseconds / 60000);
			return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
		}
	}
}).component("wealth-tracker-table", {
	props: ["state", "previous"],
	template: "#wealth-tracker-table-template",
	delimiters: ["[[", "]]"],
	computed: {
		snapshots() {
			return Array.isArray(this.state) ? [...this.state].sort((a, b) => Number(b.timestamp) - Number(a.timestamp)) : [];
		},
		latestItems() {
			return Object.values(this.snapshots[0]?.itemBreakdown || {}).sort((a, b) => Number(b.totalValue) - Number(a.totalValue));
		},
		latestDelta() {
			if (!Array.isArray(this.previous) || !this.previous.length || !this.snapshots.length) return null;
			const latestPrevious = [...this.previous].sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0];
			return Number(this.snapshots[0].totalNetWorth) - Number(latestPrevious.totalNetWorth);
		}
	},
	methods: {
		formatSnapshotDate(timestamp) {
			return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
		},
		formatGold(value) {
			return (Number(value) || 0).toLocaleString();
		},
		otherValue(snapshot) {
			return (Number(snapshot.lootingBagValue) || 0) + (Number(snapshot.seedVaultValue) || 0) + (Number(snapshot.groupStorageValue) || 0);
		}
	}
}).mount("#app");
