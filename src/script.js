// Production mode detection (disable logs for privacy)
const DEBUG = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const log = {
	debug: DEBUG ? console.log.bind(console) : () => {},
	info: console.info.bind(console),
	error: console.error.bind(console)
};

// State
let peer = null;
let localStream = null;
let currentCall = null;
let currentFacingMode = "environment"; // default to back camera
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = 0;
let recordingInterval = null;

// DOM Elements
const views = {
	selection: document.getElementById("selection-view"),
	broadcaster: document.getElementById("broadcaster-view"),
	viewer: document.getElementById("viewer-view"),
	local: document.getElementById("local-view")
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
	btnLocalScreen: document.getElementById("btn-local-screen")
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

// View Management
function switchView(viewName) {
	Object.values(views).forEach((v) => v.classList.remove("active"));
	views[viewName].classList.add("active");
}

// Generate a cryptographically secure random ID
function generatePeerId() {
	const array = new Uint8Array(8); // 8 bytes = 64 bits of entropy
	crypto.getRandomValues(array);
	const id = Array.from(array, byte => byte.toString(36)).join('').substring(0, 12);
	return `cam-${id}`;
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

// ==========================================
// BROADCASTER LOGIC
// ==========================================

async function startBroadcaster() {
	switchView("broadcaster");

	// 1. Initialize Peer
	const peerId = generatePeerId();
	UI.pairingCode.textContent = peerId;

	// Use our own PeerJS server on beamcam.live
	peer = new Peer(peerId, {
		host: 'beamcam.live',
		port: 443,
		path: '/peerjs',
		secure: true,
		debug: 3,
		config: {
			iceServers: [
				{
					urls: "stun:beamcam.live:3478"
				},
				{
					urls: [
						"turn:beamcam.live:3478?transport=udp",
						"turn:beamcam.live:3478?transport=tcp"
					],
					username: String(Math.floor(Date.now() / 1000) + 86400) + ":webrtc",
					credential: "d8aa9a7f63d62c3845a9d4fedaa365ad122e67ce3e6c679797a86c01dc0da8ab",
					credentialType: "password"
				}
			],
			iceTransportPolicy: "all"
		}
	});

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

	// 2. Start Camera
	await initCamera();

	// 3. Answer incoming calls automatically
	peer.on("call", (call) => {
		log.debug("🔥 BROADCASTER RECEIVED CALL EVENT");
		log.debug("Incoming call from viewer:", call.peer);
		currentCall = call;

		if (!localStream) {
			log.error("No local stream available!");
			showToast("Camera not ready");
			return;
		}

		log.debug("Local stream tracks:", localStream.getTracks().length);

		// Answer the call with our local video stream
		call.answer(localStream);
		log.debug("Answered call with local stream");

		updateStatus("Connecting to Viewer...");

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

		call.on("close", () => {
			log.debug("Call closed");
			currentCall = null;
			updateStatus("Ready (Waiting for viewer)");
			showToast("Viewer disconnected");
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
				height: { ideal: 720 }
			},
			audio: true
		};

		localStream = await navigator.mediaDevices.getUserMedia(constraints);
		UI.localVideo.srcObject = localStream;

		// If we are currently in a call, replace the video track
		if (currentCall) {
			const videoTrack = localStream.getVideoTracks()[0];
			const sender = currentCall.peerConnection
				.getSenders()
				.find((s) => s.track.kind === videoTrack.kind);
			if (sender) {
				sender.replaceTrack(videoTrack);
			}
		}
	} catch (err) {
		log.error("Camera error:", err.name);
		showToast("Error accessing camera. Please ensure permissions are granted.");
	}
}

function stopBroadcaster() {
	if (localStream) localStream.getTracks().forEach((t) => t.stop());
	if (currentCall) currentCall.close();
	if (peer) peer.destroy();

	updateStatus("Disconnected");
	switchView("selection");
}

// ==========================================
// VIEWER LOGIC
// ==========================================

function startViewer() {
	switchView("viewer");
	updateStatus("Initializing...");

	peer = new Peer({
		host: 'beamcam.live',
		port: 443,
		path: '/peerjs',
		secure: true,
		debug: 3,
		config: {
			iceServers: [
				{
					urls: "stun:beamcam.live:3478"
				},
				{
					urls: [
						"turn:beamcam.live:3478?transport=udp",
						"turn:beamcam.live:3478?transport=tcp"
					],
					username: String(Math.floor(Date.now() / 1000) + 86400) + ":webrtc",
					credential: "d8aa9a7f63d62c3845a9d4fedaa365ad122e67ce3e6c679797a86c01dc0da8ab",
					credentialType: "password"
				}
			],
			iceTransportPolicy: "all"
		}
	});

	peer.on("open", (id) => {
		log.debug("Viewer peer initialized with ID:", id);
		updateStatus("Ready (Enter code)");
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

	// Validation: format check (cam-XXXX where X is alphanumeric, length 4-16)
	if (!/^cam-[a-z0-9]{4,16}$/i.test(targetId)) {
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
			log.debug("Received remote stream with", remoteStream.getTracks().length, "tracks");

			// Simply attach the stream - autoplay will handle the rest
			UI.remoteVideo.srcObject = remoteStream;

			UI.connectPrompt.classList.add("hidden");
			UI.remoteVideoContainer.classList.remove("hidden");
			UI.viewerControls.classList.remove("hidden");
			updateStatus("Connected to Camera", true);
			showToast("Connected successfully!");

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
	if (UI.remoteVideo.srcObject) {
		UI.remoteVideo.srcObject.getTracks().forEach((t) => t.stop());
		UI.remoteVideo.srcObject = null;
	}

	// Reset audio to muted state
	UI.remoteVideo.muted = true;
	const overlay = document.querySelector("#remote-video-container .video-overlay");
	if (overlay) overlay.classList.remove("hidden");

	UI.connectPrompt.classList.remove("hidden");
	UI.remoteVideoContainer.classList.add("hidden");
	UI.viewerControls.classList.add("hidden");
	updateStatus("Disconnected");
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
	a.download = `droidcam_recording_${new Date().getTime()}.webm`;
	a.click();
	window.URL.revokeObjectURL(url);
	showToast("Download started!");
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

document.getElementById("btn-toggle-camera").addEventListener("click", (e) => {
	const btn = e.currentTarget;
	if (localStream) {
		const videoTrack = localStream.getVideoTracks()[0];
		if (videoTrack) {
			videoTrack.enabled = !videoTrack.enabled;
			btn.classList.toggle("active");
		}
	}
});

document.getElementById("btn-switch-camera").addEventListener("click", () => {
	currentFacingMode =
		currentFacingMode === "environment" ? "user" : "environment";
	initCamera();
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
	const icon = btn.querySelector("i");
	const overlay = document.querySelector("#remote-video-container .video-overlay");

	video.muted = !video.muted;

	if (video.muted) {
		icon.setAttribute("data-lucide", "volume-x");
		btn.title = "Unmute Audio";
		if (overlay) overlay.classList.remove("hidden");
	} else {
		icon.setAttribute("data-lucide", "volume-2");
		btn.title = "Mute Audio";
		btn.classList.add("active");
		if (overlay) overlay.classList.add("hidden");
	}

	lucide.createIcons();
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

// Hash-based routing: Auto-connect if URL contains #cam-xxxx
window.addEventListener('load', () => {
	const hash = window.location.hash.substring(1); // Remove #
	if (hash && /^cam-[a-z0-9]{4,16}$/i.test(hash)) {
		log.debug("Auto-connecting to:", hash);
		// Wait a bit for the UI to initialize
		setTimeout(() => {
			document.getElementById("btn-viewer").click();
			// Pre-fill the input
			setTimeout(() => {
				UI.inputPeerId.value = hash;
				document.getElementById("btn-connect").click();
			}, 500);
		}, 100);
	}
});

// Register Service Worker - DISABLED FOR TESTING
// if ("serviceWorker" in navigator) {
// 	window.addEventListener("load", () => {
// 		navigator.serviceWorker
// 			.register("/sw.js")
// 			.then((registration) => {
// 				console.log("SW registered: ", registration);
// 			})
// 			.catch((registrationError) => {
// 				console.log("SW registration failed: ", registrationError);
// 			});
// 	});
// }

// Unregister any existing service worker for testing
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.getRegistrations().then((registrations) => {
		for (let registration of registrations) {
			log.debug("Unregistering SW:", registration.scope);
			registration.unregister();
		}
	});
}
