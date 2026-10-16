// Production mode detection (disable logs for privacy)
const DEBUG = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const log = {
	debug: DEBUG ? console.log.bind(console) : () => {},
	info: console.info.bind(console),
	error: console.error.bind(console)
};

// Deployment settings: dist/config.js, generated from .env by bin/build.sh.
// Public values only (name, hosts, enabled apps); secrets never reach it.
const CONFIG = window.APP_CONFIG || {};
const APP_NAME = CONFIG.name || "Cam";
const SIGNALING = Object.assign(
	{ host: window.location.hostname, port: 443, path: "/peerjs", secure: true },
	CONFIG.signaling
);
const SIGNALING_URL = `${SIGNALING.secure ? "https" : "http"}://${SIGNALING.host}:${SIGNALING.port}${SIGNALING.path}`;
const STUN_URL = CONFIG.stun || `stun:${SIGNALING.host}:3478`;
const APPS = Object.assign({ live: true, videocall: true, audiocall: true, editor: true }, CONFIG.apps);

// State
let peer = null;
let localStream = null;
let currentCall = null;
let currentFacingMode = "environment"; // default to back camera
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = 0;
let recordingInterval = null;
let focusLocked = false;
let exposureLocked = false;
let currentBitrate = 1500; // kbps, manual cap (ignored while autoBitrate is on)
let autoBitrate = true;
let adaptiveTimer = null;
let currentFramerate = 30;
let wakeLock = null;
let pendingTargetId = null; // pairing code to call as soon as the viewer peer is open
let talkTrack = null; // viewer's real mic track, swapped in for push-to-talk
let filters = { brightness: 1, contrast: 1, grayscale: 0 };
let filterPipeline = null; // WebGL processing, only alive while a filter is set
let broadcastSource = "camera"; // what the camera phone sends: "camera" | "screen" | "off"

// DOM Elements
const views = {
	selection: document.getElementById("selection-view"),
	broadcaster: document.getElementById("broadcaster-view"),
	viewer: document.getElementById("viewer-view"),
	local: document.getElementById("local-view"),
	call: document.getElementById("call-view")
};

const UI = {
	statusBadge: document.getElementById("status-badge"),
	pairingCode: document.getElementById("pairing-code"),
	localVideo: document.getElementById("local-video"),
	remoteVideo: document.getElementById("remote-video"),
	remoteVideoContainer: document.getElementById("remote-video-container"),
	inputPeerId: document.getElementById("input-peer-id"),
	viewerControls: document.getElementById("viewer-controls"),
	connectPrompt: document.querySelector(".connect-prompt"),
	recorderVideo: document.getElementById("recorder-video"),
	recordingIndicator: document.getElementById("recording-indicator"),
	recordingTime: document.getElementById("recording-time"),
	localSetupControls: document.getElementById("local-setup-controls"),
	localRecordingControls: document.getElementById("local-recording-controls"),
	localPlaybackControls: document.getElementById("local-playback-controls"),
	btnLocalStartRecord: document.getElementById("btn-local-start-record"),
	btnLocalCamera: document.getElementById("btn-local-camera"),
	btnLocalScreen: document.getElementById("btn-local-screen"),
	btnTalk: document.getElementById("btn-talk"),
	pairingCard: document.getElementById("pairing-card"),
	pairingPill: document.getElementById("pairing-pill"),
	pairingPillCode: document.getElementById("pairing-pill-code"),
	talkbackAudio: document.getElementById("talkback-audio")
};

// Toast utility
function showToast(message) {
	const container = document.getElementById("toast-container");
	const toast = document.createElement("div");
	toast.className = "toast";
	toast.textContent = message;
	container.appendChild(toast);

	setTimeout(() => {
		toast.style.opacity = "0";
		toast.style.transform = "translateX(100%)";
		setTimeout(() => toast.remove(), 300);
	}, 3000);
}

// Swap a button's Lucide icon. createIcons() replaces <i data-lucide> with an
// <svg>, so the original <i> is gone after the first render.
function setIcon(btn, name) {
	const icon = btn.querySelector("i, svg");
	if (icon) icon.outerHTML = `<i data-lucide="${name}"></i>`;
	lucide.createIcons();
}

// View Management
function switchView(viewName) {
	Object.values(views).forEach((v) => v.classList.remove("active"));
	views[viewName].classList.add("active");
}

// Generate a cryptographically secure random ID
function generatePeerId(prefix = "cam") {
	const array = new Uint8Array(8); // 8 bytes = 64 bits of entropy
	crypto.getRandomValues(array);
	const id = Array.from(array, byte => byte.toString(36)).join('').substring(0, 12);
	return `${prefix}-${id}`;
}

// Update status UI
function updateStatus(status, isConnected = false) {
	UI.statusBadge.textContent = status;
	if (isConnected) {
		UI.statusBadge.classList.add("connected");
		UI.statusBadge.classList.remove("disconnected");
	} else {
		UI.statusBadge.classList.add("disconnected");
		UI.statusBadge.classList.remove("connected");
	}
}

// Keep the screen on: mobile browsers suspend the camera when the device sleeps
async function requestWakeLock() {
	if (!("wakeLock" in navigator)) return;
	try {
		wakeLock = await navigator.wakeLock.request("screen");
		wakeLock.addEventListener("release", () => { wakeLock = null; });
	} catch (err) {
		log.debug("Wake lock unavailable:", err.name);
	}
}

function releaseWakeLock() {
	if (wakeLock) wakeLock.release();
	wakeLock = null;
}

// The lock is dropped whenever the tab is hidden, so take it back on return
document.addEventListener("visibilitychange", () => {
	const streaming = views.broadcaster.classList.contains("active") || !!UI.remoteVideo.srcObject ||
		views.call.classList.contains("active");
	if (document.visibilityState === "visible" && streaming && !wakeLock) {
		requestWakeLock();
	}
});

// ICE servers. TURN credentials are short-lived HMACs minted by the
// signaling server (/peerjs/turn): the coturn secret never ships to clients.
// If that fails we still have STUN, which covers most networks.
let iceConfigCache = null;
let iceConfigExpiry = 0;

async function getIceConfig() {
	const now = Date.now() / 1000;
	if (iceConfigCache && now < iceConfigExpiry) return iceConfigCache;

	try {
		const response = await fetch(`${SIGNALING_URL}/turn`, { cache: "no-store" });
		if (!response.ok) throw new Error("HTTP " + response.status);
		const data = await response.json();
		iceConfigCache = { iceServers: data.iceServers, iceTransportPolicy: "all" };
		iceConfigExpiry = now + data.ttl / 2; // refresh well before coturn rejects them
		return iceConfigCache;
	} catch (err) {
		log.error("TURN credentials unavailable, falling back to STUN only:", err.message);
		return {
			iceServers: [{ urls: STUN_URL }],
			iceTransportPolicy: "all"
		};
	}
}

// ==========================================
// BROADCASTER LOGIC
// ==========================================

async function startBroadcaster() {
	switchView("broadcaster");

	// Check if PeerJS server is available
	if (!peerServerAvailable) {
		showToast("Warning: PeerJS server unreachable. Broadcaster may not work without connection.");
	}

	// 1. Initialize Peer
	const peerId = generatePeerId();
	UI.pairingCode.textContent = peerId;
	UI.pairingPillCode.textContent = peerId;
	showPairingCard(true);

	peer = new Peer(peerId, peerOptions(await getIceConfig()));

	peer.on("open", (id) => {
		log.debug("✅ Broadcaster peer opened with ID:", id);
		updateStatus("Ready (Waiting for viewer)");

		// Generate QR code with full URL
		const url = `${window.location.origin}${window.location.pathname}#${id}`;
		const qrContainer = document.getElementById("qrcode-container");
		qrContainer.innerHTML = ""; // Clear previous QR code
		new QRCode(qrContainer, {
			text: url,
			width: 180,
			height: 180,
			colorDark: "#000000",
			colorLight: "#ffffff",
			correctLevel: QRCode.CorrectLevel.M
		});
	});

	peer.on("error", (err) => {
		log.error("❌ Broadcaster peer error:", err.type);
		showToast("Connection error: " + err.type);
	});

	peer.on("disconnected", () => {
		log.debug("⚠️ Broadcaster peer disconnected, attempting reconnect...");
		if (!peer.destroyed) {
			peer.reconnect();
		}
	});

	peer.on("close", () => {
		log.debug("🔴 Broadcaster peer closed");
	});

	peer.on("connection", (conn) => {
		log.debug("Broadcaster received data connection:", conn);
	});

	// 2. Start Camera. Not awaited: the call handler below must be attached
	// right away, or a viewer who scans the QR code while the permission
	// prompt is still up gets dropped (PeerJS doesn't replay missed events).
	broadcastSource = "camera";
	const cameraReady = initCamera().then(refreshBroadcastControls);
	requestWakeLock();

	// 3. Answer incoming calls automatically
	peer.on("call", async (call) => {
		await cameraReady;
		log.debug("🔥 BROADCASTER RECEIVED CALL EVENT");
		log.debug("Incoming call from viewer:", call.peer);
		currentCall = call;

		if (!localStream) {
			log.error("No local stream available!");
			showToast("Camera not ready");
			return;
		}

		log.debug("Local stream tracks:", localStream.getTracks().length);

		// Answer the call with our local video stream (filtered if a filter is set)
		call.answer(getOutgoingStream());
		log.debug("Answered call with local stream");

		updateStatus("Connecting to Viewer...");

		// Play the viewer's audio (push-to-talk); silent until they hold the talk button
		call.on("stream", (viewerStream) => {
			UI.talkbackAudio.srcObject = viewerStream;
			UI.talkbackAudio.play().catch((err) => log.debug("Talk-back autoplay blocked:", err.name));
		});

		// Apply bitrate to the outgoing video sender once connection is ready
		setTimeout(() => {
			if (call && call.peerConnection) {
				const sender = call.peerConnection.getSenders().find(s => s.track && s.track.kind === "video");
				if (sender) {
					applyBitrateToSender(sender, autoBitrate ? ADAPT_LEVELS[adaptLevel][1] : 1);
				}
			}
		}, 1000);

		// Poll WebRTC stats to detect when connection is established
		const checkConnectionStats = async () => {
			if (!call || !call.peerConnection) {
				log.debug("No peerConnection available yet");
				return;
			}

			const pc = call.peerConnection;
			const state = pc.iceConnectionState;
			log.debug("📊 Polling ICE state:", state);

			if (state === "connected" || state === "completed") {
				log.debug("🎉 Connection established!");
				updateStatus("Connected to Viewer", true);
				showPairingCard(false); // get out of the way of the picture
				showToast("Viewer connected!");
				return; // Stop polling
			}

			if (state === "failed" || state === "closed") {
				log.error("❌ Connection failed");
				updateStatus("Connection failed");
				return; // Stop polling
			}

			// Continue polling
			setTimeout(checkConnectionStats, 500);
		};

		// Start polling after a short delay to let peerConnection initialize
		setTimeout(checkConnectionStats, 1000);

		startAdaptiveBitrate(call);

		call.on("close", () => {
			stopAdaptiveBitrate();
			log.debug("Call closed");
			currentCall = null;
			UI.talkbackAudio.srcObject = null;
			updateStatus("Ready (Waiting for viewer)");
			showToast("Viewer disconnected");
			showPairingCard(true);
		});

		call.on("error", (err) => {
			log.error("Call error:", err);
			showToast("Connection error with viewer");
			currentCall = null;
			updateStatus("Ready (Waiting for viewer)");
		});
	});
}

async function initCamera() {
	if (localStream) {
		localStream.getTracks().forEach((t) => t.stop());
	}

	try {
		const constraints = {
			video: {
				facingMode: currentFacingMode,
				width: { ideal: 1280 },
				height: { ideal: 720 },
				frameRate: { ideal: currentFramerate }
			},
			audio: true
		};

		localStream = await navigator.mediaDevices.getUserMedia(constraints);
		if (filterPipeline) filterPipeline.setSource(localStream);
		UI.localVideo.srcObject = getOutgoingStream();

		// Apply bitrate constraint to video track
		const videoTrack = localStream.getVideoTracks()[0];
		if (videoTrack) {
			try {
				await videoTrack.applyConstraints({
					advanced: [{ frameRate: currentFramerate }]
				});
			} catch (e) {
				log.debug("Could not apply framerate constraint:", e);
			}
		}

		// If we are currently in a call, replace the video track
		if (currentCall) {
			const sender = currentCall.peerConnection
				.getSenders()
				.find((s) => s.track && s.track.kind === "video");
			if (sender) {
				await sender.replaceTrack(filterPipeline ? filterPipeline.track : videoTrack);
				// Apply encoding parameters for bitrate
				applyBitrateToSender(sender, autoBitrate ? ADAPT_LEVELS[adaptLevel][1] : 1);
			}
		}
	} catch (err) {
		log.error("Camera error:", err.name);
		showToast("Error accessing camera. Please ensure permissions are granted.");
	}
}

function applyBitrateToSender(sender, scaleDown = 1) {
	if (isScreenSharing()) scaleDown = 1; // text must stay sharp; fps gives way instead
	const parameters = sender.getParameters();
	if (!parameters.encodings || parameters.encodings.length === 0) {
		parameters.encodings = [{}];
	}
	parameters.encodings[0].maxBitrate = currentBitrate * 1000; // Convert kbps to bps
	parameters.encodings[0].scaleResolutionDownBy = scaleDown;
	sender.setParameters(parameters).catch((err) => {
		log.error("Failed to set bitrate:", err);
	});
}

function showPairingCard(show) {
	UI.pairingCard.classList.toggle("hidden", !show);
	UI.pairingPill.classList.toggle("hidden", show);
}

// ==========================================
// VIDEO SOURCE: camera / screen / off
// ==========================================
// Wherever we send live video, the camera button opens a menu to switch
// between the camera, a screen share and nothing. The swap is a
// replaceTrack() on the existing video sender: no renegotiation, the call
// stays up. Screen tracks get contentHint "detail" so the encoder keeps
// resolution (sharp text) and drops frame rate instead, and the adaptive
// bitrate never scales them down.

const SCREEN_SHARE_SUPPORTED = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

async function openScreenTrack() {
	const stream = await navigator.mediaDevices.getDisplayMedia({
		video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15, max: 30 } },
		audio: false
	});
	const track = stream.getVideoTracks()[0];
	if ("contentHint" in track) track.contentHint = "detail";
	return track;
}

function isScreenSharing() {
	return broadcastSource === "screen" || callSession.source === "screen";
}

// The picker. A "cancelled" screen prompt is not an error worth a toast.
function sourceError(kind, err) {
	if (err && err.name === "NotAllowedError" && kind === "screen") return;
	showToast(kind === "screen" ? "Screen sharing failed" : "Camera unavailable");
}

function closeSourceMenu() {
	const menu = document.getElementById("source-menu");
	if (menu) menu.remove();
	document.removeEventListener("pointerdown", onSourceMenuOutside, true);
	document.removeEventListener("keydown", onSourceMenuKey);
}

function onSourceMenuOutside(e) {
	const menu = document.getElementById("source-menu");
	if (menu && !menu.contains(e.target) && !e.target.closest("[data-source-anchor]")) closeSourceMenu();
}

function onSourceMenuKey(e) {
	if (e.key === "Escape") closeSourceMenu();
}

function openSourceMenu(anchor, current, onPick) {
	if (document.getElementById("source-menu")) return closeSourceMenu(); // second click closes
	const items = [
		{ kind: "camera", icon: "video", label: "Camera" },
		{ kind: "screen", icon: "monitor-up", label: "Share screen", disabled: !SCREEN_SHARE_SUPPORTED, note: "Not available on this device" },
		{ kind: "off", icon: "video-off", label: "Turn video off" }
	];
	const menu = document.createElement("div");
	menu.id = "source-menu";
	menu.className = "source-menu glass-panel";
	menu.setAttribute("role", "menu");
	items.forEach((it) => {
		const b = document.createElement("button");
		b.className = "source-item" + (it.kind === current ? " current" : "");
		b.disabled = !!it.disabled;
		b.setAttribute("role", "menuitemradio");
		b.setAttribute("aria-checked", it.kind === current);
		b.innerHTML = `<i data-lucide="${it.icon}"></i><span>${it.label}${it.disabled ? `<small>${it.note}</small>` : ""}</span>` +
			(it.kind === current ? `<i data-lucide="check" class="source-check"></i>` : "");
		b.addEventListener("click", () => {
			closeSourceMenu();
			if (it.kind !== current) onPick(it.kind);
		});
		menu.appendChild(b);
	});
	// In fullscreen only the fullscreen element is painted
	(document.fullscreenElement || document.body).appendChild(menu);
	lucide.createIcons();

	const r = anchor.getBoundingClientRect();
	const w = menu.offsetWidth;
	menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
	menu.style.bottom = (window.innerHeight - r.top + 10) + "px";

	document.addEventListener("pointerdown", onSourceMenuOutside, true);
	document.addEventListener("keydown", onSourceMenuKey);
}

function sourceIcon(kind) {
	return kind === "screen" ? "monitor-up" : kind === "camera" ? "video" : "video-off";
}

// --- camera phone (broadcaster)

function refreshBroadcastControls() {
	const btn = document.getElementById("btn-toggle-camera");
	btn.classList.toggle("active", broadcastSource !== "off");
	setIcon(btn, sourceIcon(broadcastSource));
	document.getElementById("btn-switch-camera").classList.toggle("hidden", broadcastSource !== "camera");
	UI.localVideo.classList.toggle("screen", broadcastSource === "screen");
}

async function setBroadcastSource(kind) {
	if (!localStream) return;
	let track;
	try {
		if (kind === "camera") {
			track = (await navigator.mediaDevices.getUserMedia({
				video: {
					facingMode: currentFacingMode,
					width: { ideal: 1280 },
					height: { ideal: 720 },
					frameRate: { ideal: currentFramerate }
				}
			})).getVideoTracks()[0];
		} else if (kind === "screen") {
			track = await openScreenTrack();
		} else {
			track = placeholderVideoTrack(); // viewer sees black, hardware released
		}
	} catch (err) {
		log.error("Source switch failed:", err.name);
		return sourceError(kind, err);
	}

	const old = localStream.getVideoTracks()[0];
	if (old) {
		localStream.removeTrack(old);
		old.stop();
	}
	localStream.addTrack(track);
	broadcastSource = kind;

	// The browser's own "Stop sharing" button: fall back to the camera
	if (kind === "screen") {
		track.addEventListener("ended", () => {
			if (localStream && localStream.getVideoTracks()[0] === track) setBroadcastSource("camera");
		});
	}

	if (filterPipeline) filterPipeline.setSource(localStream);
	UI.localVideo.srcObject = null;
	UI.localVideo.srcObject = getOutgoingStream();

	const sender = currentCall && currentCall.peerConnection &&
		currentCall.peerConnection.getSenders().find((s) => s.track && s.track.kind === "video");
	if (sender) {
		await sender.replaceTrack(filterPipeline ? filterPipeline.track : track);
		applyBitrateToSender(sender, autoBitrate ? ADAPT_LEVELS[adaptLevel][1] : 1);
	}
	refreshBroadcastControls();
	if (kind === "screen") showToast("Sharing your screen");
}

// ==========================================
// IMAGE FILTERS (brightness / contrast / grayscale)
// ==========================================
// Applied to what is *sent*, not just the preview: camera -> hidden <video>
// -> canvas (2D ctx.filter, or a WebGL shader where that's missing)
// -> canvas.captureStream(). GPU work, no per-pixel JS. Grayscale also saves bits: flat chroma planes
// compress to almost nothing. The pipeline only exists while a filter is
// set; at neutral values the raw camera track is sent untouched.

const FILTER_VERTEX = `
attribute vec2 p;
varying vec2 uv;
void main() {
	uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
	gl_Position = vec4(p, 0.0, 1.0);
}`;

const FILTER_FRAGMENT = `
precision mediump float;
uniform sampler2D tex;
uniform float brightness;
uniform float contrast;
uniform float grayscale;
varying vec2 uv;
void main() {
	vec3 c = texture2D(tex, uv).rgb;
	float luma = dot(c, vec3(0.299, 0.587, 0.114));
	c = mix(c, vec3(luma), grayscale);
	c = (c - 0.5) * contrast + 0.5;
	c *= brightness;
	gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function filtersActive() {
	return filters.brightness !== 1 || filters.contrast !== 1 || filters.grayscale !== 0;
}

// Renderer A: Canvas 2D with ctx.filter (Chrome, Edge, Firefox; GPU-backed)
function create2dRenderer(canvas) {
	const ctx = canvas.getContext("2d");
	if (!ctx || !("filter" in ctx)) return null;
	return (video) => {
		ctx.filter = `grayscale(${filters.grayscale}) contrast(${filters.contrast}) brightness(${filters.brightness})`;
		ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
	};
}

// Renderer B: WebGL fragment shader (browsers without ctx.filter, e.g. older Safari)
function createGlRenderer(canvas) {
	const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true });
	if (!gl) return null;

	const compile = (type, src) => {
		const shader = gl.createShader(type);
		gl.shaderSource(shader, src);
		gl.compileShader(shader);
		return shader;
	};
	const program = gl.createProgram();
	gl.attachShader(program, compile(gl.VERTEX_SHADER, FILTER_VERTEX));
	gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FILTER_FRAGMENT));
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
	gl.useProgram(program);

	gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
	const loc = gl.getAttribLocation(program, "p");
	gl.enableVertexAttribArray(loc);
	gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

	gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

	const u = {
		brightness: gl.getUniformLocation(program, "brightness"),
		contrast: gl.getUniformLocation(program, "contrast"),
		grayscale: gl.getUniformLocation(program, "grayscale")
	};

	return (video) => {
		gl.viewport(0, 0, canvas.width, canvas.height);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
		gl.uniform1f(u.brightness, filters.brightness);
		gl.uniform1f(u.contrast, filters.contrast);
		gl.uniform1f(u.grayscale, filters.grayscale);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	};
}

function createFilterPipeline(sourceStream) {
	// A canvas can only ever get one context type, so try each on its own canvas
	let canvas = document.createElement("canvas");
	let render = create2dRenderer(canvas);
	if (!render) {
		canvas = document.createElement("canvas");
		render = createGlRenderer(canvas);
	}
	if (!render) return null;

	// iOS only decodes frames for a video element that is in the document
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;";
	document.body.appendChild(video);

	let running = true;
	const draw = () => {
		if (!running) return;
		if (video.readyState >= 2 && video.videoWidth) {
			if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
				canvas.width = video.videoWidth;
				canvas.height = video.videoHeight;
			}
			render(video);
		}
		schedule();
	};
	// One draw per camera frame where supported, else per display frame
	const schedule = () => video.requestVideoFrameCallback
		? video.requestVideoFrameCallback(draw)
		: requestAnimationFrame(draw);

	const setSource = (stream) => {
		video.srcObject = new MediaStream(stream.getVideoTracks());
		video.play().catch(() => {});
	};
	setSource(sourceStream);
	schedule();

	const track = canvas.captureStream().getVideoTracks()[0];
	return {
		track,
		setSource,
		stop() {
			running = false;
			track.stop();
			video.srcObject = null;
			video.remove();
		}
	};
}

// The stream we show and send: raw camera, or camera through the filters
function getOutgoingStream() {
	if (!localStream) return null;
	if (!filterPipeline) return localStream;
	return new MediaStream([filterPipeline.track, ...localStream.getAudioTracks()]);
}

async function updateFilters() {
	if (!localStream) return;
	const wanted = filtersActive();
	if (wanted === !!filterPipeline) return; // uniforms are read on every frame

	if (wanted) {
		filterPipeline = createFilterPipeline(localStream);
		if (!filterPipeline) {
			showToast("Image filters are not supported in this browser");
			return;
		}
	} else {
		filterPipeline.stop();
		filterPipeline = null;
	}

	UI.localVideo.srcObject = getOutgoingStream();
	const sender = currentCall && currentCall.peerConnection &&
		currentCall.peerConnection.getSenders().find((s) => s.track && s.track.kind === "video");
	if (sender) {
		await sender.replaceTrack(filterPipeline ? filterPipeline.track : localStream.getVideoTracks()[0]);
	}
}

// ==========================================
// ADAPTIVE BITRATE
// ==========================================
// WebRTC congestion control already reacts within seconds. This sits on top
// and picks a cap the link has *sustained*: sample getStats() every 2 s, keep
// a 3-minute window, and budget on a low percentile of measured bandwidth so
// a flaky link settles on a quality it can actually hold instead of
// oscillating. Everything is measured locally on the broadcaster.

const ADAPT_INTERVAL_MS = 2000;
const ADAPT_WINDOW = 90; // samples -> 3 minutes
const ADAPT_LEVELS = [ // [cap kbps, resolution divider]
	[300, 2],   // ~360p
	[600, 2],
	[1000, 1.5], // ~480p
	[1500, 1],  // 720p
	[2500, 1],
	[4000, 1]
];

let adaptSamples = [];
let adaptLevel = 3; // start at 1.5 Mbps / 720p
let adaptWarmup = 0;
let lastBytesSent = 0;
let lastStatsTime = 0;

function startAdaptiveBitrate(call) {
	stopAdaptiveBitrate();
	adaptSamples = [];
	adaptLevel = 3;
	adaptWarmup = 0;
	lastBytesSent = 0;
	lastStatsTime = 0;
	adaptiveTimer = setInterval(() => sampleAndAdapt(call), ADAPT_INTERVAL_MS);
}

function stopAdaptiveBitrate() {
	clearInterval(adaptiveTimer);
	adaptiveTimer = null;
}

async function sampleAndAdapt(call) {
	if (!autoBitrate || !call || !call.peerConnection) return;
	const pc = call.peerConnection;
	const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
	if (!sender) return;

	const stats = await pc.getStats();
	let available = 0, loss = 0, rtt = 0, bytesSent = 0;
	stats.forEach((r) => {
		if (r.type === "candidate-pair" && r.nominated && r.availableOutgoingBitrate) {
			available = r.availableOutgoingBitrate / 1000;
			rtt = r.currentRoundTripTime || 0;
		}
		if (r.type === "remote-inbound-rtp" && r.kind === "video") {
			loss = r.fractionLost || 0;
		}
		if (r.type === "outbound-rtp" && r.kind === "video") {
			bytesSent = r.bytesSent;
		}
	});

	// Firefox has no availableOutgoingBitrate: fall back to what we really push
	const now = Date.now();
	if (!available && lastStatsTime && bytesSent > lastBytesSent) {
		available = ((bytesSent - lastBytesSent) * 8) / (now - lastStatsTime) * 1.2;
	}
	lastBytesSent = bytesSent;
	lastStatsTime = now;
	if (!available) return;

	// Skip the first 10 s: the bandwidth estimator starts low and ramps up
	if (++adaptWarmup <= 5) return;

	adaptSamples.push({ available, loss, rtt });
	if (adaptSamples.length > ADAPT_WINDOW) adaptSamples.shift();
	if (adaptSamples.length < 5) return; // need ~10 s of history first

	// Sustained budget: 20th percentile of measured bandwidth
	const sorted = adaptSamples.map((s) => s.available).sort((a, b) => a - b);
	let budget = sorted[Math.floor(sorted.length * 0.2)];

	// Recent instability (last 30 s) costs extra headroom
	const recent = adaptSamples.slice(-15);
	const avgLoss = recent.reduce((a, s) => a + s.loss, 0) / recent.length;
	if (avgLoss > 0.05) budget *= 0.7;
	else if (avgLoss > 0.02) budget *= 0.85;

	// Hysteresis band. The estimate tends to sit near what we already send,
	// so "budget below the current cap" alone would ratchet us down forever.
	//   down: sustained budget < 90% of the current cap -> straight to the
	//         highest level that fits in 85% of the budget
	//   up:   sustained budget > 125% of the next level and a clean link -> +1
	const current = ADAPT_LEVELS[adaptLevel][0];
	const next = ADAPT_LEVELS[adaptLevel + 1];
	if (budget < current * 0.9) {
		let target = 0;
		ADAPT_LEVELS.forEach(([kbps], i) => { if (kbps <= budget * 0.85) target = i; });
		if (target >= adaptLevel) return;
		adaptLevel = target;
	} else if (next && budget > next[0] * 1.25 && avgLoss < 0.02) {
		adaptLevel += 1;
	} else {
		return;
	}

	const [kbps, scale] = ADAPT_LEVELS[adaptLevel];
	currentBitrate = kbps;
	applyBitrateToSender(sender, scale);
	log.debug(`Adaptive: budget ${Math.round(budget)} kbps, loss ${(avgLoss * 100).toFixed(1)}% -> ${kbps} kbps, scale 1/${scale}`);
}

function stopBroadcaster() {
	if (localStream) localStream.getTracks().forEach((t) => t.stop());
	if (currentCall) currentCall.close();
	if (peer) peer.destroy();
	UI.talkbackAudio.srcObject = null;
	stopAdaptiveBitrate();
	releaseWakeLock();
	if (filterPipeline) filterPipeline.stop();
	filterPipeline = null;

	updateStatus("Disconnected");
	switchView("selection");
}

// ==========================================
// VIEWER LOGIC
// ==========================================

async function startViewer() {
	// Double-check connectivity
	if (!peerServerAvailable) {
		showToast("Cannot start viewer: PeerJS server unreachable");
		return;
	}

	switchView("viewer");
	updateStatus("Initializing...");

	peer = new Peer(peerOptions(await getIceConfig()));

	peer.on("open", (id) => {
		log.debug("Viewer peer initialized with ID:", id);
		updateStatus("Ready (Enter code)");
		if (pendingTargetId) {
			UI.inputPeerId.value = pendingTargetId;
			pendingTargetId = null;
			connectToCamera();
		}
	});

	peer.on("error", (err) => {
		log.error("Peer error:", err.type);
		showToast("Connection error: " + err.type);
		updateStatus("Error - Try again");
	});
}

async function connectToCamera() {
	const targetId = UI.inputPeerId.value.trim();

	// Validation: empty input
	if (!targetId) {
		showToast("Please enter a pairing code");
		return;
	}

	// A call code typed here: hand over to the call lobby
	if (/^call-[a-z0-9]{4,16}$/i.test(targetId) && (APPS.videocall || APPS.audiocall)) {
		if (peer) peer.destroy();
		openJoinLobby(targetId);
		return;
	}

	// Validation: format check (cam-XXXX where X is alphanumeric, length 4-16)
	if (!APPS.live || !/^cam-[a-z0-9]{4,16}$/i.test(targetId)) {
		showToast("Invalid pairing code format");
		return;
	}

	if (!peer || !peer.id) {
		showToast("Peer not ready, please wait...");
		return;
	}

	updateStatus("Connecting...");
	log.debug("🔥 VIEWER ATTEMPTING TO CALL:", targetId);

	try {
		// Create a dummy video stream (black frame) so the offer includes video
		const canvas = document.createElement('canvas');
		canvas.width = 640;
		canvas.height = 480;
		const canvasStream = canvas.captureStream(1);

		// Add silent audio
		const audioContext = new AudioContext();
		const destination = audioContext.createMediaStreamDestination();

		// Combine video and audio into one stream
		const dummyStream = new MediaStream([
			...canvasStream.getVideoTracks(),
			...destination.stream.getAudioTracks()
		]);
		log.debug("Created dummy stream for viewer");

		// Initiate call
		currentCall = peer.call(targetId, dummyStream);

		if (!currentCall) {
			showToast("Failed to initiate call");
			updateStatus("Connection failed");
			return;
		}

		log.debug("Call initiated, waiting for stream...");

		// Set a timeout for connection
		const connectionTimeout = setTimeout(() => {
			if (currentCall && !UI.remoteVideo.srcObject) {
				log.error("Connection timeout");
				showToast("Connection timeout - check the pairing code");
				disconnectViewer();
			}
		}, 15000);

		currentCall.on("stream", (remoteStream) => {
			clearTimeout(connectionTimeout);
			if (UI.remoteVideo.srcObject === remoteStream) return; // fired again for the second track
			log.debug("Received remote stream with", remoteStream.getTracks().length, "tracks");

			// Simply attach the stream - autoplay will handle the rest
			UI.remoteVideo.srcObject = remoteStream;

			UI.connectPrompt.classList.add("hidden");
			UI.remoteVideoContainer.classList.remove("hidden");
			UI.viewerControls.classList.remove("hidden");
			updateStatus("Connected to Camera", true);
			showToast("Connected successfully!");
			requestWakeLock();

			// Recreate lucide icons for the unmute hint
			setTimeout(() => lucide.createIcons(), 100);
		});

		currentCall.on("close", () => {
			clearTimeout(connectionTimeout);
			log.debug("Call closed by remote peer");
			disconnectViewer();
			showToast("Camera disconnected");
		});

		currentCall.on("error", (err) => {
			clearTimeout(connectionTimeout);
			log.error("Call error:", err);
			showToast("Call error: " + err);
			disconnectViewer();
		});
	} catch (err) {
		log.error("Error creating connection:", err.name);
		showToast("Connection error: " + err.message);
		updateStatus("Connection failed");
	}
}

function disconnectViewer() {
	if (currentCall) currentCall.close();
	stopTalking();
	if (talkTrack) talkTrack.stop();
	talkTrack = null;
	releaseWakeLock();
	if (UI.remoteVideo.srcObject) {
		UI.remoteVideo.srcObject.getTracks().forEach((t) => t.stop());
		UI.remoteVideo.srcObject = null;
	}

	// Reset audio to muted state
	UI.remoteVideo.muted = true;
	const audioBtn = document.getElementById("btn-toggle-audio");
	audioBtn.classList.remove("active");
	setIcon(audioBtn, "volume-x");
	const overlay = document.querySelector("#remote-video-container .video-overlay");
	if (overlay) overlay.classList.remove("hidden");

	UI.connectPrompt.classList.remove("hidden");
	UI.remoteVideoContainer.classList.add("hidden");
	UI.viewerControls.classList.add("hidden");
	updateStatus("Disconnected");
}

// Push-to-talk: the call was opened with a silent audio track, so the
// audio transceiver is already negotiated. Swapping in the real mic is a
// replaceTrack() away - no renegotiation needed.
async function startTalking() {
	if (!currentCall || !currentCall.peerConnection) return;
	const sender = currentCall.peerConnection
		.getSenders()
		.find((s) => s.track && s.track.kind === "audio");
	if (!sender) return;

	try {
		if (!talkTrack || talkTrack.readyState === "ended") {
			const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
			talkTrack = micStream.getAudioTracks()[0];
			await sender.replaceTrack(talkTrack);
		}
		talkTrack.enabled = true;
		UI.btnTalk.classList.add("talking");
	} catch (err) {
		log.error("Mic error:", err.name);
		showToast("Microphone unavailable. Please grant permission.");
	}
}

function stopTalking() {
	if (talkTrack) talkTrack.enabled = false;
	UI.btnTalk.classList.remove("talking");
}

// ==========================================
// LOCAL RECORDER LOGIC
// ==========================================

async function startLocalRecorder() {
	switchView("local");
	updateStatus("Local Recorder Setup");
	resetLocalState();
}

function resetLocalState() {
	if (localStream) localStream.getTracks().forEach((t) => t.stop());
	localStream = null;
	UI.recorderVideo.srcObject = null;
	UI.recorderVideo.src = "";
	UI.recorderVideo.controls = false;
	recordedChunks = [];
	clearInterval(recordingInterval);

	UI.localSetupControls.classList.remove("hidden");
	UI.localRecordingControls.classList.add("hidden");
	UI.localPlaybackControls.classList.add("hidden");
	UI.recordingIndicator.classList.add("hidden");
	UI.btnLocalStartRecord.classList.add("hidden");

	UI.btnLocalCamera.classList.remove("active");
	UI.btnLocalScreen.classList.remove("active");
}

async function setupLocalMedia(type) {
	if (localStream) localStream.getTracks().forEach((t) => t.stop());

	try {
		if (type === "camera") {
			localStream = await navigator.mediaDevices.getUserMedia({
				video: {
					facingMode: currentFacingMode,
					width: { ideal: 1920 },
					height: { ideal: 1080 }
				},
				audio: true
			});
			UI.btnLocalCamera.classList.add("active");
			UI.btnLocalScreen.classList.remove("active");
		} else if (type === "screen") {
			localStream = await navigator.mediaDevices.getDisplayMedia({
				video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
				audio: true
			});
			UI.btnLocalScreen.classList.add("active");
			UI.btnLocalCamera.classList.remove("active");
		}

		UI.recorderVideo.srcObject = localStream;
		UI.recorderVideo.muted = true; // Mute locally to avoid feedback
		UI.btnLocalStartRecord.classList.remove("hidden");
	} catch (err) {
		log.error("Media error:", err.name);
		showToast("Error accessing media.");
	}
}

function startRecording() {
	if (!localStream) return;

	recordedChunks = [];
	try {
		mediaRecorder = new MediaRecorder(localStream, {
			mimeType: "video/webm; codecs=vp9"
		});
	} catch (e) {
		mediaRecorder = new MediaRecorder(localStream); // fallback
	}

	mediaRecorder.ondataavailable = (event) => {
		if (event.data.size > 0) {
			recordedChunks.push(event.data);
		}
	};

	mediaRecorder.onstop = () => {
		const blob = new Blob(recordedChunks, { type: "video/webm" });
		UI.recorderVideo.srcObject = null;
		UI.recorderVideo.src = URL.createObjectURL(blob);
		UI.recorderVideo.controls = true;
		UI.recorderVideo.muted = false; // Unmute for playback

		UI.localRecordingControls.classList.add("hidden");
		UI.localPlaybackControls.classList.remove("hidden");
		UI.recordingIndicator.classList.add("hidden");
		clearInterval(recordingInterval);
	};

	mediaRecorder.start(100); // harvest every 100ms
	UI.localSetupControls.classList.add("hidden");
	UI.localRecordingControls.classList.remove("hidden");
	UI.recordingIndicator.classList.remove("hidden");

	recordingStartTime = Date.now();
	updateRecordingTime();
	recordingInterval = setInterval(updateRecordingTime, 1000);
}

function updateRecordingTime() {
	const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
	const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
	const secs = String(elapsed % 60).padStart(2, "0");
	UI.recordingTime.textContent = `${mins}:${secs}`;
}

function stopRecording() {
	if (mediaRecorder && mediaRecorder.state !== "inactive") {
		mediaRecorder.stop();
		if (localStream) localStream.getTracks().forEach((t) => t.stop());
	}
}

function downloadRecording() {
	if (recordedChunks.length === 0) return;

	const blob = new Blob(recordedChunks, { type: "video/webm" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	document.body.appendChild(a);
	a.style = "display: none";
	a.href = url;
	a.download = `${APP_NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-")}_recording_${new Date().getTime()}.webm`;
	a.click();
	window.URL.revokeObjectURL(url);
	showToast("Download started!");
}

// ==========================================
// 1-TO-1 CALL
// ==========================================
// Same plumbing as camera/viewer, but both ends send. The host shows a
// call-xxxx code; the joiner dials it. Both m-lines (audio + video) are
// always negotiated - with a 1 fps black placeholder when the camera is off -
// so the camera can be switched on and off later with replaceTrack(), no
// renegotiation. "Off" really is off: the sender gets a null track (zero
// bitrate) and the camera hardware is released. A small data channel carries
// cam/mic state so the other side shows an avatar instead of a black frame.

const CALL_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

const callSession = {
	role: null,        // "host" | "joiner"
	media: null,       // MediaConnection
	conn: null,        // DataConnection (state messages)
	mic: null,         // our mic track
	cam: null,         // our outgoing video track (camera or screen), null when off
	source: null,      // "camera" | "screen" | null
	prevSource: null,  // where to go back to when a screen share ends
	facing: "user",
	placeholder: null, // black video track used for negotiation only
	silence: null,     // silent audio track if the mic is unavailable
	remoteCam: true,
	timeout: null
};

const CallUI = {
	remote: document.getElementById("call-remote"),
	self: document.getElementById("call-self"),
	remoteOff: document.getElementById("call-remote-off"),
	waiting: document.getElementById("call-waiting"),
	waitingText: document.getElementById("call-waiting-text"),
	muted: document.getElementById("call-remote-muted"),
	sound: document.getElementById("btn-call-sound"),
	card: document.getElementById("call-card"),
	cardTitle: document.getElementById("call-card-title"),
	code: document.getElementById("call-code"),
	lobby: document.getElementById("call-lobby"),
	lobbyCode: document.getElementById("call-lobby-code"),
	controls: document.getElementById("call-controls"),
	btnMic: document.getElementById("btn-call-mic"),
	btnCam: document.getElementById("btn-call-cam"),
	btnSwitch: document.getElementById("btn-call-switch"),
	btnSpeaker: document.getElementById("btn-call-speaker")
};

function placeholderVideoTrack() {
	const canvas = document.createElement("canvas");
	canvas.width = 640;
	canvas.height = 480;
	canvas.getContext("2d").fillRect(0, 0, 640, 480);
	return canvas.captureStream(1).getVideoTracks()[0];
}

function silentAudioTrack() {
	const ctx = new AudioContext();
	return ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
}

async function openCallCamera() {
	const stream = await navigator.mediaDevices.getUserMedia({
		video: { facingMode: callSession.facing, width: { ideal: 1280 }, height: { ideal: 720 } }
	});
	return stream.getVideoTracks()[0];
}

async function setupCallMedia(withVideo) {
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: CALL_AUDIO });
		callSession.mic = stream.getAudioTracks()[0];
	} catch (err) {
		log.error("Mic error:", err.name);
		showToast("Microphone unavailable: you can listen but not talk");
	}
	if (withVideo) {
		try {
			callSession.cam = await openCallCamera();
			callSession.source = "camera";
		} catch (err) {
			log.error("Camera error:", err.name);
			showToast("Camera unavailable: continuing with audio only");
		}
	}
	refreshCallControls();
	showSelfView();
}

// The stream handed to PeerJS: always one video + one audio track
function negotiationStream() {
	if (!callSession.placeholder) callSession.placeholder = placeholderVideoTrack();
	if (!callSession.mic && !callSession.silence) callSession.silence = silentAudioTrack();
	return new MediaStream([callSession.cam || callSession.placeholder, callSession.mic || callSession.silence]);
}

function callSender(kind) {
	const pc = callSession.media && callSession.media.peerConnection;
	if (!pc) return null;
	const t = pc.getTransceivers().find((tr) => tr.receiver.track && tr.receiver.track.kind === kind);
	return t ? t.sender : null;
}

// Push the real camera state to the video sender (null = send nothing)
async function syncCamSender() {
	const sender = callSender("video");
	if (sender) await sender.replaceTrack(callSession.cam || null).catch((e) => log.debug("replaceTrack:", e));
}

function sendCallState() {
	if (callSession.conn && callSession.conn.open) {
		callSession.conn.send({
			cam: !!callSession.cam,
			screen: callSession.source === "screen",
			mic: !!(callSession.mic && callSession.mic.enabled)
		});
	}
}

function showSelfView() {
	CallUI.self.classList.toggle("hidden", !callSession.cam);
	CallUI.self.classList.toggle("mirror", callSession.source === "camera" && callSession.facing === "user");
	CallUI.self.classList.toggle("screen", callSession.source === "screen");
	CallUI.self.srcObject = callSession.cam ? new MediaStream([callSession.cam]) : null;
}

function refreshCallControls() {
	const micOn = !!(callSession.mic && callSession.mic.enabled);
	CallUI.btnMic.classList.toggle("active", micOn);
	setIcon(CallUI.btnMic, micOn ? "mic" : "mic-off");
	CallUI.btnCam.classList.toggle("active", !!callSession.cam);
	setIcon(CallUI.btnCam, sourceIcon(callSession.source || "off"));
	CallUI.btnSwitch.classList.toggle("hidden", callSession.source !== "camera");
}

function updateRemoteView() {
	const connected = !!CallUI.remote.srcObject;
	CallUI.waiting.classList.toggle("hidden", connected);
	CallUI.remoteOff.classList.toggle("hidden", !connected || callSession.remoteCam);
}

function playRemote() {
	CallUI.remote.play().then(() => {
		CallUI.sound.classList.add("hidden");
	}).catch(() => {
		// Autoplay with sound refused: one tap fixes it
		CallUI.sound.classList.remove("hidden");
	});
}

function resetCallStage(waitingText) {
	CallUI.remote.srcObject = null;
	callSession.remoteCam = true;
	CallUI.remote.classList.remove("screen");
	CallUI.muted.classList.add("hidden");
	CallUI.sound.classList.add("hidden");
	CallUI.waitingText.textContent = waitingText;
	updateRemoteView();
}

function attachCallMedia(mediaConnection) {
	callSession.media = mediaConnection;

	mediaConnection.on("stream", (remoteStream) => {
		if (CallUI.remote.srcObject === remoteStream) return; // fired once per track
		clearTimeout(callSession.timeout);
		CallUI.remote.srcObject = remoteStream;
		playRemote();
		updateRemoteView();
		CallUI.card.classList.add("hidden");
		updateStatus("In call", true);
		syncCamSender();
		startAdaptiveBitrate(mediaConnection);
		requestWakeLock();
	});

	// Late events from a call we already ended must not end the next one
	const current = () => callSession.media === mediaConnection;
	mediaConnection.on("close", () => current() && endCall("Call ended"));
	mediaConnection.on("error", (err) => {
		log.error("Call error:", err);
		if (current()) endCall("Call failed");
	});

	// PeerJS doesn't always fire "close" on the far side: watch ICE too
	const watchIce = () => {
		const pc = mediaConnection.peerConnection;
		if (!pc) return setTimeout(watchIce, 500);
		pc.addEventListener("iceconnectionstatechange", () => {
			if ((pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") && current()) {
				endCall("Connection lost");
			}
		});
	};
	watchIce();

	// Drop the placeholder as soon as the sender exists, if the camera is off
	setTimeout(syncCamSender, 0);
}

function attachCallData(conn) {
	callSession.conn = conn;
	conn.on("open", sendCallState);
	conn.on("data", (msg) => {
		if (!msg || typeof msg !== "object" || callSession.conn !== conn) return;
		if (msg.bye) return endCall("The other person hung up");
		if (typeof msg.cam === "boolean") {
			callSession.remoteCam = msg.cam;
			updateRemoteView();
		}
		if (typeof msg.screen === "boolean") {
			// A shared screen must be shown whole, never cropped
			CallUI.remote.classList.toggle("screen", msg.screen);
		}
		if (typeof msg.mic === "boolean") {
			CallUI.muted.classList.toggle("hidden", msg.mic);
		}
	});
	conn.on("close", () => {
		if (callSession.conn === conn) endCall("Call ended");
	});
}

function peerOptions(iceConfig) {
	return { ...SIGNALING, debug: DEBUG ? 2 : 0, config: iceConfig };
}

async function startCallHost(withVideo) {
	switchView("call");
	callSession.role = "host";
	callSession.facing = "user";
	CallUI.lobby.classList.add("hidden");
	CallUI.controls.classList.remove("hidden");
	CallUI.cardTitle.textContent = withVideo ? "Video call" : "Audio call";
	CallUI.card.classList.remove("hidden");
	resetCallStage("Waiting for someone to join…");
	updateStatus("Starting call…");

	await setupCallMedia(withVideo);

	const id = generatePeerId("call");
	CallUI.code.textContent = id;
	peer = new Peer(id, peerOptions(await getIceConfig()));

	peer.on("open", () => {
		updateStatus("Waiting for the other person");
		const qr = document.getElementById("call-qrcode");
		qr.innerHTML = "";
		new QRCode(qr, {
			text: `${window.location.origin}${window.location.pathname}#${id}`,
			width: 180,
			height: 180,
			colorDark: "#000000",
			colorLight: "#ffffff",
			correctLevel: QRCode.CorrectLevel.M
		});
	});

	// 1 to 1: anyone else knocking while we're busy is turned away
	peer.on("call", (incoming) => {
		if (callSession.media) return incoming.close();
		incoming.answer(negotiationStream());
		attachCallMedia(incoming);
	});
	peer.on("connection", (conn) => {
		if (callSession.conn && callSession.conn.open) return conn.close();
		attachCallData(conn);
	});
	peer.on("disconnected", () => { if (!peer.destroyed) peer.reconnect(); });
	peer.on("error", (err) => {
		log.error("Call peer error:", err.type);
		showToast("Connection error: " + err.type);
	});
}

function openJoinLobby(targetId) {
	switchView("call");
	callSession.role = "joiner";
	CallUI.card.classList.add("hidden");
	CallUI.controls.classList.add("hidden");
	CallUI.lobbyCode.textContent = targetId;
	CallUI.lobby.dataset.target = targetId;
	CallUI.lobby.classList.remove("hidden");
	resetCallStage("Connecting…");
	updateStatus("Ready to join");
}

async function joinCall(withVideo) {
	const targetId = CallUI.lobby.dataset.target;
	CallUI.lobby.classList.add("hidden");
	CallUI.controls.classList.remove("hidden");
	callSession.facing = "user";
	updateStatus("Connecting…");

	await setupCallMedia(withVideo);

	peer = new Peer(peerOptions(await getIceConfig()));
	peer.on("open", () => {
		attachCallMedia(peer.call(targetId, negotiationStream()));
		attachCallData(peer.connect(targetId, { reliable: true }));
		callSession.timeout = setTimeout(() => {
			if (!CallUI.remote.srcObject) endCall("No answer: check the code, or the call has ended");
		}, 15000);
	});
	peer.on("error", (err) => {
		log.error("Join error:", err.type);
		endCall(err.type === "peer-unavailable" ? "That call doesn't exist (anymore)" : "Connection error: " + err.type);
	});
}

// Ends the conversation. The host keeps its code and waits for the next
// caller; the joiner goes home.
function endCall(reason) {
	if (!callSession.role) return;
	clearTimeout(callSession.timeout);
	stopAdaptiveBitrate();
	const media = callSession.media, conn = callSession.conn;
	callSession.media = null;
	callSession.conn = null;
	if (conn && conn.open) {
		try { conn.send({ bye: true }); } catch (e) { /* closing anyway */ }
	}
	setTimeout(() => {
		if (media) media.close();
		if (conn) conn.close();
	}, 100);

	if (reason) showToast(reason);

	if (callSession.role === "host" && peer && !peer.destroyed) {
		resetCallStage("Waiting for someone to join…");
		CallUI.card.classList.remove("hidden");
		updateStatus("Waiting for the other person");
	} else {
		leaveCall();
	}
}

// Full teardown: release camera/mic, drop the peer, back to the menu
function leaveCall() {
	const role = callSession.role;
	callSession.role = null;
	clearTimeout(callSession.timeout);
	stopAdaptiveBitrate();
	[callSession.mic, callSession.cam, callSession.placeholder, callSession.silence].forEach((t) => t && t.stop());
	Object.assign(callSession, { media: null, conn: null, mic: null, cam: null, source: null, prevSource: null, placeholder: null, silence: null, remoteCam: true });
	CallUI.remote.classList.remove("screen");
	if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
	CallUI.remote.srcObject = null;
	CallUI.self.srcObject = null;
	// Give the "bye" message a moment to leave before tearing the peer down
	const oldPeer = peer;
	if (oldPeer && role) setTimeout(() => oldPeer.destroy(), 200);
	releaseWakeLock();
	updateStatus("Disconnected");
	switchView("selection");
}

async function setCallSource(kind) {
	let track = null;
	try {
		if (kind === "camera") track = await openCallCamera();
		else if (kind === "screen") track = await openScreenTrack();
	} catch (err) {
		log.error("Source switch failed:", err.name);
		return sourceError(kind, err);
	}

	if (callSession.cam) callSession.cam.stop(); // releases the hardware, camera light goes off
	if (kind === "screen") callSession.prevSource = callSession.source;
	callSession.cam = track;
	callSession.source = track ? kind : null;

	// The browser's own "Stop sharing" button: back to what we had before
	if (kind === "screen") {
		track.addEventListener("ended", () => {
			if (callSession.cam === track) setCallSource(callSession.prevSource || "off");
		});
	}

	await syncCamSender();
	const sender = callSender("video");
	if (sender && track) applyBitrateToSender(sender, ADAPT_LEVELS[adaptLevel][1]);
	showSelfView();
	refreshCallControls();
	sendCallState();
}

async function switchCallCamera() {
	if (callSession.source !== "camera") return;
	callSession.facing = callSession.facing === "user" ? "environment" : "user";
	const old = callSession.cam;
	try {
		old.stop(); // some phones can't open both cameras at once
		callSession.cam = await openCallCamera();
	} catch (err) {
		showToast("Could not switch camera");
		callSession.cam = null;
	}
	await syncCamSender();
	showSelfView();
	refreshCallControls();
	sendCallState();
}

function toggleCallMic() {
	if (!callSession.mic) return showToast("No microphone available");
	callSession.mic.enabled = !callSession.mic.enabled;
	refreshCallControls();
	sendCallState();
}

// ==========================================
// EVENT LISTENERS
// ==========================================

document
	.getElementById("btn-broadcaster")
	.addEventListener("click", startBroadcaster);
document.getElementById("btn-viewer").addEventListener("click", startViewer);
document
	.getElementById("btn-local")
	.addEventListener("click", startLocalRecorder);

document.getElementById("btn-copy-code").addEventListener("click", () => {
	const peerId = UI.pairingCode.textContent;
	const url = `${window.location.origin}${window.location.pathname}#${peerId}`;
	navigator.clipboard.writeText(url);
	showToast("Link copied to clipboard!");
});

document.getElementById("bitrate-select").addEventListener("change", (e) => {
	autoBitrate = e.target.value === "auto";
	if (autoBitrate) {
		adaptSamples = [];
		showToast("Adaptive bitrate on");
		return;
	}
	currentBitrate = parseInt(e.target.value);
	log.debug("Bitrate changed to:", currentBitrate, "kbps");

	// Apply to active call if exists
	if (currentCall && currentCall.peerConnection) {
		const sender = currentCall.peerConnection.getSenders().find(s => s.track && s.track.kind === "video");
		if (sender) {
			applyBitrateToSender(sender);
			showToast(`Bitrate updated to ${currentBitrate >= 1000 ? currentBitrate/1000 + ' Mbps' : currentBitrate + ' kbps'}`);
		}
	}
});

document.getElementById("framerate-select").addEventListener("change", async (e) => {
	currentFramerate = parseInt(e.target.value);
	log.debug("Framerate changed to:", currentFramerate, "fps");

	// Apply to local stream
	if (localStream) {
		const videoTrack = localStream.getVideoTracks()[0];
		if (videoTrack) {
			try {
				await videoTrack.applyConstraints({
					frameRate: { ideal: currentFramerate }
				});
				showToast(`Framerate updated to ${currentFramerate} fps`);
			} catch (err) {
				log.error("Failed to apply framerate:", err);
				showToast("Failed to update framerate");
			}
		}
	}
});

// Image filter sliders
const FILTER_INPUTS = {
	brightness: document.getElementById("filter-brightness"),
	contrast: document.getElementById("filter-contrast"),
	grayscale: document.getElementById("filter-grayscale")
};

function syncFilterOutputs() {
	Object.entries(FILTER_INPUTS).forEach(([key, input]) => {
		filters[key] = parseInt(input.value, 10) / 100;
		const out = document.querySelector(`output[data-for="${input.id}"]`);
		if (out) out.textContent = `${input.value}%`;
	});
}

Object.values(FILTER_INPUTS).forEach((input) =>
	input.addEventListener("input", () => {
		syncFilterOutputs();
		updateFilters();
	})
);

document.getElementById("btn-reset-filters").addEventListener("click", () => {
	FILTER_INPUTS.brightness.value = 100;
	FILTER_INPUTS.contrast.value = 100;
	FILTER_INPUTS.grayscale.value = 0;
	syncFilterOutputs();
	updateFilters();
});

// Pairing card collapse / expand
document.getElementById("btn-collapse-card").addEventListener("click", () => showPairingCard(false));
UI.pairingPill.addEventListener("click", () => showPairingCard(true));

// Speaker: the viewer's push-to-talk voice on the camera phone
document.getElementById("btn-toggle-speaker").addEventListener("click", (e) => {
	const btn = e.currentTarget;
	UI.talkbackAudio.muted = !UI.talkbackAudio.muted;
	btn.classList.toggle("active", !UI.talkbackAudio.muted);
	setIcon(btn, UI.talkbackAudio.muted ? "volume-x" : "volume-2");
	showToast(UI.talkbackAudio.muted ? "Speaker off" : "Speaker on");
});

document.getElementById("btn-toggle-camera").addEventListener("click", (e) => {
	openSourceMenu(e.currentTarget, broadcastSource, setBroadcastSource);
});

document.getElementById("btn-toggle-mic").addEventListener("click", (e) => {
	const btn = e.currentTarget;
	if (localStream) {
		const audioTrack = localStream.getAudioTracks()[0];
		if (audioTrack) {
			audioTrack.enabled = !audioTrack.enabled;
			btn.classList.toggle("active", audioTrack.enabled);
			setIcon(btn, audioTrack.enabled ? "mic" : "mic-off");
		}
	}
});

document.getElementById("btn-switch-camera").addEventListener("click", () => {
	currentFacingMode =
		currentFacingMode === "environment" ? "user" : "environment";
	initCamera();
});

document.getElementById("btn-lock-focus").addEventListener("click", async (e) => {
	const btn = e.currentTarget;
	if (!localStream) return;

	const videoTrack = localStream.getVideoTracks()[0];
	if (!videoTrack) return;

	try {
		const capabilities = videoTrack.getCapabilities();
		if (!capabilities.focusMode || !capabilities.focusMode.includes("manual")) {
			showToast("Focus lock not supported on this device");
			return;
		}

		focusLocked = !focusLocked;
		await videoTrack.applyConstraints({
			advanced: [{ focusMode: focusLocked ? "manual" : "continuous" }]
		});

		btn.classList.toggle("active", focusLocked);
		showToast(focusLocked ? "Focus locked" : "Focus unlocked");
	} catch (err) {
		log.error("Focus lock error:", err);
		showToast("Failed to lock focus");
	}
});

document.getElementById("btn-lock-exposure").addEventListener("click", async (e) => {
	const btn = e.currentTarget;
	if (!localStream) return;

	const videoTrack = localStream.getVideoTracks()[0];
	if (!videoTrack) return;

	try {
		const capabilities = videoTrack.getCapabilities();
		if (!capabilities.exposureMode || !capabilities.exposureMode.includes("manual")) {
			showToast("Exposure lock not supported on this device");
			return;
		}

		exposureLocked = !exposureLocked;
		await videoTrack.applyConstraints({
			advanced: [{ exposureMode: exposureLocked ? "manual" : "continuous" }]
		});

		btn.classList.toggle("active", exposureLocked);
		showToast(exposureLocked ? "Exposure locked" : "Exposure unlocked");
	} catch (err) {
		log.error("Exposure lock error:", err);
		showToast("Failed to lock exposure");
	}
});

document
	.getElementById("btn-stop-broadcast")
	.addEventListener("click", stopBroadcaster);

// Viewer Controls
document
	.getElementById("btn-connect")
	.addEventListener("click", connectToCamera);
UI.inputPeerId.addEventListener("keypress", (e) => {
	if (e.key === "Enter") connectToCamera();
});

document.getElementById("btn-stop-viewing").addEventListener("click", () => {
	disconnectViewer();
	if (peer) peer.destroy();
	switchView("selection");
});

// Audio toggle for viewer
function toggleViewerAudio() {
	const video = UI.remoteVideo;
	const btn = document.getElementById("btn-toggle-audio");
	const overlay = document.querySelector("#remote-video-container .video-overlay");

	video.muted = !video.muted;

	setIcon(btn, video.muted ? "volume-x" : "volume-2");
	btn.title = video.muted ? "Unmute Audio" : "Mute Audio";
	btn.classList.toggle("active", !video.muted);
	if (overlay) overlay.classList.toggle("hidden", !video.muted);
}

document.getElementById("btn-toggle-audio").addEventListener("click", toggleViewerAudio);

// Unmute hint button (in overlay)
document.getElementById("btn-unmute-hint").addEventListener("click", () => {
	toggleViewerAudio();
});

document.getElementById("btn-fullscreen").addEventListener("click", () => {
	if (UI.remoteVideoContainer.requestFullscreen) {
		UI.remoteVideoContainer.requestFullscreen();
	} else if (UI.remoteVideoContainer.webkitRequestFullscreen) {
		/* Safari */
		UI.remoteVideoContainer.webkitRequestFullscreen();
	}
});

// Push-to-talk (hold). Space bar works too on desktop.
UI.btnTalk.addEventListener("pointerdown", (e) => {
	e.preventDefault();
	UI.btnTalk.setPointerCapture(e.pointerId);
	startTalking();
});
["pointerup", "pointercancel", "lostpointercapture"].forEach((evt) =>
	UI.btnTalk.addEventListener(evt, stopTalking)
);
UI.btnTalk.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("keydown", (e) => {
	if (e.code === "Space" && !e.repeat && e.target === document.body && UI.remoteVideo.srcObject) {
		e.preventDefault();
		startTalking();
	}
});
document.addEventListener("keyup", (e) => {
	if (e.code === "Space") stopTalking();
});

// Call controls
document.getElementById("btn-call-video").addEventListener("click", () => startCallHost(true));
document.getElementById("btn-call-audio").addEventListener("click", () => startCallHost(false));
document.getElementById("btn-join-video").addEventListener("click", () => joinCall(true));
document.getElementById("btn-join-audio").addEventListener("click", () => joinCall(false));
CallUI.btnMic.addEventListener("click", toggleCallMic);
CallUI.btnCam.addEventListener("click", (e) => openSourceMenu(e.currentTarget, callSession.source || "off", setCallSource));
function toggleFullscreen(el) {
	if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
	if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
	else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen(); // Safari
}
document.getElementById("btn-call-fullscreen").addEventListener("click", () => toggleFullscreen(views.call));
CallUI.remote.addEventListener("dblclick", () => toggleFullscreen(views.call));
UI.remoteVideo.addEventListener("dblclick", () => toggleFullscreen(UI.remoteVideoContainer));
CallUI.btnSwitch.addEventListener("click", switchCallCamera);
CallUI.btnSpeaker.addEventListener("click", () => {
	CallUI.remote.muted = !CallUI.remote.muted;
	CallUI.btnSpeaker.classList.toggle("active", !CallUI.remote.muted);
	setIcon(CallUI.btnSpeaker, CallUI.remote.muted ? "volume-x" : "volume-2");
});
CallUI.sound.addEventListener("click", playRemote);
document.getElementById("btn-call-hangup").addEventListener("click", () => {
	endCall(null);
	leaveCall();
});
document.getElementById("btn-call-copy").addEventListener("click", () => {
	const url = `${window.location.origin}${window.location.pathname}#${CallUI.code.textContent}`;
	navigator.clipboard.writeText(url);
	showToast("Call link copied!");
});

// Local Recorder Controls
document
	.getElementById("btn-local-camera")
	.addEventListener("click", () => setupLocalMedia("camera"));
document
	.getElementById("btn-local-screen")
	.addEventListener("click", () => setupLocalMedia("screen"));
document
	.getElementById("btn-local-start-record")
	.addEventListener("click", startRecording);
document
	.getElementById("btn-local-stop-record")
	.addEventListener("click", stopRecording);
document
	.getElementById("btn-local-download")
	.addEventListener("click", downloadRecording);
document
	.getElementById("btn-local-discard")
	.addEventListener("click", resetLocalState);
document.getElementById("btn-local-close").addEventListener("click", () => {
	resetLocalState();
	switchView("selection");
	updateStatus("Disconnected");
});

lucide.createIcons();

// Connectivity check: Test PeerJS server availability
let peerServerAvailable = true;

async function checkPeerServerConnectivity() {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 3000);

		// Not /peers: discovery is disabled server-side, so it always answers 401
		const response = await fetch(`${SIGNALING_URL}/`, {
			signal: controller.signal,
			cache: 'no-store'
		});
		clearTimeout(timeoutId);

		peerServerAvailable = response.ok;
	} catch (err) {
		log.debug("PeerJS server unreachable:", err.message);
		peerServerAvailable = false;
	}

	const viewerBtn = document.getElementById("btn-viewer");
	if (!peerServerAvailable) {
		viewerBtn.disabled = true;
		viewerBtn.style.opacity = "0.4";
		viewerBtn.style.cursor = "not-allowed";
		viewerBtn.title = "Requires internet connection to PeerJS server";
		showToast("Viewer mode unavailable: PeerJS server unreachable");
	} else {
		viewerBtn.disabled = false;
		viewerBtn.style.opacity = "1";
		viewerBtn.style.cursor = "pointer";
		viewerBtn.title = "";
	}

	log.debug("PeerJS server available:", peerServerAvailable);
}

// Check connectivity on page load
checkPeerServerConnectivity();

// Recheck on online/offline events
window.addEventListener('online', checkPeerServerConnectivity);
window.addEventListener('offline', () => {
	peerServerAvailable = false;
	const viewerBtn = document.getElementById("btn-viewer");
	viewerBtn.disabled = true;
	viewerBtn.style.opacity = "0.4";
	viewerBtn.style.cursor = "not-allowed";
	showToast("Offline: Viewer mode disabled");
});

// Hash-based routing:
//   #cam-xxxx  -> open viewer and connect (QR codes / shared links)
//   #camera, #viewer, #record -> open that mode directly (landing page buttons)
// Apps switched off in .env (APP_LIVE, APP_VIDEOCALL, APP_AUDIOCALL,
// APP_EDITOR): their tiles disappear and their links stop working.
function applyAppFlags() {
	const show = (id, on) => document.getElementById(id).classList.toggle("hidden", !on);
	show("btn-broadcaster", APPS.live);
	show("btn-viewer", APPS.live || APPS.videocall || APPS.audiocall); // also where call codes are typed
	show("btn-call-video", APPS.videocall);
	show("btn-call-audio", APPS.audiocall);
	document.querySelector(".call-buttons").classList.toggle("hidden", !APPS.videocall && !APPS.audiocall);
	show("btn-local", APPS.editor);
	show("btn-join-video", APPS.videocall);
	show("btn-join-audio", APPS.audiocall);
	show("btn-call-cam", APPS.videocall); // audio-only deployments never send video
	if (!APPS.live) {
		document.querySelector("#btn-viewer strong").textContent = "Join a call";
		document.querySelector("#btn-viewer .btn-text span").textContent = "Enter a call code";
	}
}

function routeFromHash() {
	const hash = window.location.hash.substring(1);
	const allowed = {
		camera: APPS.live, viewer: APPS.live, record: APPS.editor,
		videocall: APPS.videocall, audiocall: APPS.audiocall
	};
	if (hash in allowed && !allowed[hash]) return;
	if (/^cam-/i.test(hash) && !APPS.live) return;
	if (/^call-/i.test(hash) && !APPS.videocall && !APPS.audiocall) return;

	if (/^cam-[a-z0-9]{4,16}$/i.test(hash)) {
		log.debug("Auto-connecting to:", hash);
		pendingTargetId = hash;
		startViewer();
	} else if (hash === "camera") {
		startBroadcaster();
	} else if (hash === "viewer") {
		startViewer();
	} else if (hash === "record") {
		startLocalRecorder();
	} else if (hash === "videocall") {
		startCallHost(true);
	} else if (hash === "audiocall") {
		startCallHost(false);
	} else if (/^call-[a-z0-9]{4,16}$/i.test(hash)) {
		openJoinLobby(hash);
	}
}

applyAppFlags();
window.addEventListener("load", routeFromHash);

// Service Worker: DISABLED. An earlier one intercepted the PeerJS signaling
// WebSocket. Unregister any worker left over from earlier versions.
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.getRegistrations().then((registrations) => {
		for (let registration of registrations) {
			log.debug("Unregistering SW:", registration.scope);
			registration.unregister();
		}
	});
}
