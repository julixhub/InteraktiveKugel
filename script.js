/**
 * BASIS SETUP & VARIABLEN
 */
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const videoElement = document.getElementById('input_video'); // Video-Element für MediaPipe
const handStatus = document.getElementById('hand-status');
const colorIndicator = document.getElementById('user-color-indicator');
const indexElem = document.getElementById('client-index');

// Die URL für den WebSocket-Servers
const webRoomsWebSocketServerAddr = 'wss://nosch.uber.space/web-rooms/'; 

let width, height, particles = []; // Partikel-Array
let clientId = null, clientCount = 0; // Eigene User-ID
let myMouse = { x: -2000, y: -2000, id: null }; // Eigene Hand-Position
let remoteMice = new Map();

const colors = ['#FFD700', '#00FFFF', '#FF00FF', '#7FFF00', '#FF4500', '#00BFFF', '#FFFFFF', '#FF1493']; // Farbschema pro User

/** SOUND SYSTEM **/
let audioCtx;
function playUserSound(id, x, y) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const osc = audioCtx.createOscillator(); // Lautstärke 
    const gain = audioCtx.createGain();
    
    const types = ['sine', 'triangle', 'square', 'sawtooth'];
    osc.type = types[id % types.length];

/** Frequenzberechnung **/
    const baseFreq = 100 + (id * 50) % 300; // User-basierte Frequenz
    const yFreq = (1 - y / height) * 400;   // Position-basierte Frequenz
    const freq = baseFreq + yFreq;
    
    // Tonverlauf
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.2, audioCtx.currentTime + 0.5);

    // Lautstärkeverlauf
    gain.gain.setValueAtTime(0.05, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.5);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    // Abspielen und stoppen
    osc.start();
    osc.stop(audioCtx.currentTime + 0.5);
}

/** PARTIKEL LOGIK **/
class Particle {
    constructor(x, y) {
        this.baseX = x; this.baseY = y; // Ursprüngliche Position
        this.x = x; this.y = y;         // Aktuelle Position
        this.size = Math.random() * 2 + 1; // Partikelgröße
        this.speed = 0.15;
        this.currentColor = '#444';      
    }
/** Zeichent ein Partikel **/
    draw() {
        ctx.fillStyle = this.currentColor;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fill();
    }
    update(allMice) {
        let combinedDx = 0, combinedDy = 0;
        let activeColor = null;

        allMice.forEach(m => {
            // Umrechnung der normalisierten Netzwerk-Koordinaten (0-1) in lokale Pixel
            const targetX = m.isLocal ? m.x : m.x * width;
            const targetY = m.isLocal ? m.y : m.y * height;

            let dx = targetX - this.x, dy = targetY - this.y;
            let dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 120) { // Interaktion im Radius 
                let force = (120 - dist) / 120;
                combinedDx -= (dx / dist) * force * 40;
                combinedDy -= (dy / dist) * force * 40;
                activeColor = colors[m.id % colors.length];
                
                if (Math.random() > 0.99) {
                    playUserSound(m.id || 0, targetX, targetY);
                }
            }
        });
        // Farbe wird gesetzt 
        this.currentColor = activeColor ? activeColor : '#444';
        this.x += combinedDx + (this.baseX - this.x) * this.speed;
        this.y += combinedDy + (this.baseY - this.y) * this.speed;
    }
}

function initScene() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
    particles = [];
    const count = 1000, radius = 200; // Partikelanzahl
    for (let i = 0; i < count; i++) { // Kugelradius
        let phi = Math.acos(-1 + (2 * i) / count);
        let theta = Math.sqrt(count * Math.PI) * phi;
        particles.push(new Particle(
            width / 2 + radius * Math.sin(phi) * Math.cos(theta),
            height / 2 + radius * Math.sin(phi) * Math.sin(theta)
        ));
    }
}

/** HAND TRACKING (MediaPipe) **/
const hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
});

hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
});

hands.onResults((results) => { // Handerkennungsergebnisse 
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        handStatus.innerText = "Hand erkannt! 👋";
        const tip = results.multiHandLandmarks[0][8]; 
        
        // Umrechnung auf Canvas-Koordinaten
        myMouse.x = (1 - tip.x) * width;
        myMouse.y = tip.y * height;
        myMouse.id = clientId;
        myMouse.isLocal = true;

        // Netzwerk-Update
        if (clientId !== null) {
            // Sende normalisierte Koordinaten (0.0 bis 1.0)
            sendRequest('*broadcast-message*', ['move', clientId, 1 - tip.x, tip.y]);
        }
    } else {
        handStatus.innerText = "Hand suchen...";
        myMouse.x = -2000;
    }
});
// Kamera-Setup
const camera = new Camera(videoElement, {
    onFrame: async () => { await hands.send({image: videoElement}); },
    width: 640, height: 480
});

/** NETZWERK **/
const socket = new WebSocket(webRoomsWebSocketServerAddr);

socket.onopen = () => {
    document.body.classList.add('connected');
    const statusText = document.getElementById('status-text');
    if(statusText) statusText.innerText = "Online";
    
    sendRequest('*enter-room*', 'hand-sphere-room'); // Raum beitreten
    sendRequest('*subscribe-client-count*');
    
    // Keep-alive Ping
    setInterval(() => socket.send(''), 30000);
};

socket.onmessage = (e) => {
    if (e.data.length === 0) return;
    const msg = JSON.parse(e.data);
    const selector = msg[0];

    switch (selector) {
        case '*client-id*':
            clientId = msg[1];
            if (colorIndicator) colorIndicator.style.backgroundColor = colors[clientId % colors.length];
            break;

        case '*client-count*':
            clientCount = msg[1];
            break;

        case 'move':
            const remoteId = msg[1];
            if (remoteId !== clientId) {
                remoteMice.set(remoteId, { 
                    id: remoteId, 
                    x: msg[2], 
                    y: msg[3],
                    isLocal: false 
                });
            }
            break;

        case 'end':
            remoteMice.delete(msg[1]);
            break;
    }

    if (indexElem) {
        indexElem.innerText = `User: #${clientId} / Total: ${clientCount}`;
        if (colorIndicator) indexElem.appendChild(colorIndicator);
    }
};
// Sende WebSocket-Nachricht
function sendRequest(...m) { 
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m)); 
}

/** ANIMATION LOOP **/
function animate() {
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(0, 0, width, height);
    
    const allMice = [myMouse, ...Array.from(remoteMice.values())]; // Alle User werden gesammelt
    // Partikel-Update
    particles.forEach(p => { 
        p.update(allMice); 
        p.draw(); 
    });
    requestAnimationFrame(animate);
}

window.onload = () => {
    initScene();
    camera.start();
    animate();
};

window.onresize = initScene;
// AudioContext Unlock
window.addEventListener('pointerdown', () => {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
});
