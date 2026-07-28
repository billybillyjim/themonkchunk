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
		};
	},
	delimiters: ["[[", "]]"],
	computed: {
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
	},
	beforeUnmount() {
		window.removeEventListener("keydown", this.handleKeyboard);
		this.stopPlayback();
	},
	methods: {
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
}).mount("#app");
