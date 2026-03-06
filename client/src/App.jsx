import React, { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';
import './App.css';

const CELL_SIZE = 32;
const FONT = '32px monospace';

// Audio Context for Retro Sounds
let audioCtx = null;
const playSound = (freq, type = 'square', duration = 0.1, vol = 0.1) => {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
  gain.gain.setValueAtTime(vol, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
};

// --- SHARED MOVEMENT LOGIC (Sync with Server) ---
const applyMovement = (dx, dy, pos, maze) => {
  if (!pos || !maze) return;
  const speed = 0.2;
  const playerSize = 0.35;
  const moveX = dx * speed;
  const moveY = dy * speed;

  if (moveX !== 0) {
    const targetX = pos.x + Math.sign(moveX) * playerSize + moveX;
    const gx = Math.floor(targetX);
    const gy = Math.floor(pos.y);
    if (maze[gy] && maze[gy][gx] === 0) {
      pos.x += moveX;
    } else if (moveX > 0) {
      pos.x = Math.floor(pos.x) + 1 - playerSize;
    } else if (moveX < 0) {
      pos.x = Math.ceil(pos.x - 0.5) + playerSize;
    }
  }

  if (moveY !== 0) {
    const targetY = pos.y + Math.sign(moveY) * playerSize + moveY;
    const gy = Math.floor(targetY);
    const gx = Math.floor(pos.x);
    if (maze[gy] && maze[gy][gx] === 0) {
      pos.y += moveY;
    } else if (moveY > 0) {
      pos.y = Math.floor(pos.y) + 1 - playerSize;
    } else if (moveY < 0) {
      pos.y = Math.ceil(pos.y - 0.5) + playerSize;
    }
  }
};
// --- /SHARED MOVEMENT LOGIC ---

// --- INTERPOLATION HELPERS ---
const lerp = (a, b, t) => a + (b - a) * t;

const getInterpolatedPosition = (id, type, renderTime, buffer) => {
  // Find two states that bracket the renderTime
  let stateA = null;
  let stateB = null;

  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i].localTime <= renderTime) {
      stateA = buffer[i];
      if (i + 1 < buffer.length) stateB = buffer[i + 1];
      break;
    }
  }

  if (!stateA || !stateB) {
    const latest = buffer[buffer.length - 1];
    if (!latest) return null;
    const items = type === 'player' ? latest.players : latest.snipes;
    const item = items[id] || items.find?.(s => s.id === id);
    return item ? { x: item.x, y: item.y } : null;
  }

  const t = (renderTime - stateA.localTime) / (stateB.localTime - stateA.localTime);
  const itemsA = type === 'player' ? stateA.players : stateA.snipes;
  const itemsB = type === 'player' ? stateB.players : stateB.snipes;

  const itemA = type === 'player' ? itemsA[id] : itemsA.find(s => s.id === id);
  const itemB = type === 'player' ? itemsB[id] : itemsB.find(s => s.id === id);

  if (!itemA || !itemB) return itemA || itemB; // Fallback to whatever we have

  return {
    x: lerp(itemA.x, itemB.x, t),
    y: lerp(itemA.y, itemB.y, t)
  };
};
// --- /INTERPOLATION HELPERS ---

function App() {
  const canvasRef = useRef(null);
  const socketRef = useRef(null);
  const [gameState, setGameState] = useState(null);
  const gameStateRef = useRef(null);
  const [myId, setMyId] = useState(null);
  const keysRef = useRef({});
  const lastInputRef = useRef({ dx: 0, dy: 0 });
  const pendingInputsRef = useRef([]);
  const stateBufferRef = useRef([]); // History for interpolation
  const INTERPOLATION_DELAY = 100; // ms
  const nextSeqRef = useRef(0);
  const predictedPosRef = useRef({ x: 0, y: 0 });
  const lastShootTimeRef = useRef(0);
  const flashTimeRef = useRef(0);
  const [name, setName] = useState('');
  const [view, setView] = useState('lobby'); // lobby, game
  const [flash, setFlash] = useState(false);
  const [isAdmin, setIsAdmin] = useState(window.location.hash === '#admin');

  const [countdown, setCountdown] = useState(0);
  const [hives, setHives] = useState([]);
  const [bullets, setBullets] = useState([]);
  const [gameMode, setGameMode] = useState('COOP');
  const [gameOverReason, setGameOverReason] = useState('');
  const [maze, setMaze] = useState(null);
  const [matchState, setMatchState] = useState('LOBBY');
  const [maxPlayers, setMaxPlayers] = useState(15);
  const [serverFull, setServerFull] = useState(false);

  useEffect(() => {
    // If running in dev mode, hit the localhost backend. If in production (Docker/Nginx), use relative paths to route through reverse proxy
    const serverUrl = import.meta.env.DEV ? 'http://localhost:3001' : '';
    socketRef.current = io(serverUrl);
    const socket = socketRef.current; // Alias for brevity

    socket.on('init', (data) => {
      console.log('INIT received:', data);
      setGameState(data);
      gameStateRef.current = data;
      setMyId(data.id);
      if (data.gameMode) setGameMode(data.gameMode);
      if (data.matchState) setMatchState(data.matchState);
      if (data.maxPlayers) setMaxPlayers(data.maxPlayers);

      // Initialize local prediction
      if (data.players && data.players[data.id]) {
        predictedPosRef.current = { x: data.players[data.id].x, y: data.players[data.id].y };
      }
    });

    socket.on('server_full', () => {
        setServerFull(true);
        socket.disconnect();
    });

    socket.on('stateUpdate', (state) => {
      if (state.matchState) setMatchState(state.matchState);
      if (state.countdown !== undefined) setCountdown(state.countdown);
      if (state.gameMode) setGameMode(state.gameMode);

      // IMPORTANT: Update the mutable ref directly, skipping React's slow render lifecycle
      if (gameStateRef.current) {
        if (state.players && gameStateRef.current.players[myId] && state.players[myId]) {
          if (state.players[myId].health < gameStateRef.current.players[myId].health) {
            setFlash(true);
            flashTimeRef.current = Date.now();
            playSound(150, 'sawtooth', 0.2, 0.2);
            setTimeout(() => setFlash(false), 100);
          }
        }

        const nextState = {
          ...gameStateRef.current,
          ...state
        };
        gameStateRef.current = nextState;

        // Add to interpolation buffer with local timestamp
        stateBufferRef.current.push({
          ...state,
          localTime: Date.now()
        });
        // Keep buffer small (last 500ms should be plenty)
        const nowMs = Date.now();
        stateBufferRef.current = stateBufferRef.current.filter(s => nowMs - s.localTime < 1000);

        // --- CSP RECONCILIATION ---
        if (state.players && state.players[myId] && state.lastProcessedSeq !== undefined) {
          const serverPlayer = state.players[myId];
          
          // 1. Reset baseline to absolute server truth
          predictedPosRef.current = { x: serverPlayer.x, y: serverPlayer.y };

          // 2. Filter out acknowledged inputs
          pendingInputsRef.current = pendingInputsRef.current.filter(
            input => input.seq > state.lastProcessedSeq
          );

          // 3. Re-apply all unacknowledged inputs to the server baseline
          pendingInputsRef.current.forEach(input => {
            applyMovement(input.dx, input.dy, predictedPosRef.current, nextState.maze);
          });
        }
        // --- /CSP RECONCILIATION ---

        // Throttle React UI updates to ~5Hz so the HUD updates without lagging the canvas loop
        const now = Date.now();
        if (now - (gameStateRef.current.lastReactUpdate || 0) > 200) {
          setGameState(nextState);
          gameStateRef.current.lastReactUpdate = now;
        }
      }
    });

    socket.on('player_shoot', () => {
      playSound(400, 'square', 0.05, 0.05);
    });

    socket.on('gameOver', (data) => {
      setGameOverReason(data.reason || 'GAME OVER');
    });

    return () => socket.disconnect();
  }, []); // Run only once on mount

  const joinGame = (e) => {
    e.preventDefault();
    if (!name) return;
    socketRef.current.emit('join', { name });
    setView('game');
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  };

  const adminStart = () => {
    console.log('ADMIN: Clicked START MATCH');
    socketRef.current.emit('admin_start');
  };
  const adminReset = () => {
    console.log('ADMIN: Clicked RESET');
    socketRef.current.emit('admin_reset');
  };

  // Input Handling
  useEffect(() => {
    const handleKeyDown = (e) => {
      const code = e.code;
      const key = e.key;

      if (e.target.tagName === 'INPUT') return;

      // Prevent default for game keys to stop scrolling
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'w', 'a', 's', 'd', 'W', 'A', 'S', 'D'].includes(key) ||
        ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(code)) {
        e.preventDefault();
      }

      const keys = keysRef.current;
      if (code) keys[code] = true;
      if (key) keys[key] = true;
      // Normalize WASD
      if (key === 'w' || key === 'W') keys['KeyW'] = true;
      if (key === 'a' || key === 'A') keys['KeyA'] = true;
      if (key === 's' || key === 'S') keys['KeyS'] = true;
      if (key === 'd' || key === 'D') keys['KeyD'] = true;
      // Normalize Arrows (fallback for older browsers)
      if (key === 'Up') keys['ArrowUp'] = true;
      if (key === 'Down') keys['ArrowDown'] = true;
      if (key === 'Left') keys['ArrowLeft'] = true;
      if (key === 'Right') keys['ArrowRight'] = true;
    };

    const handleKeyUp = (e) => {
      const code = e.code;
      const key = e.key;

      const keys = keysRef.current;
      if (code) keys[code] = false;
      if (key) keys[key] = false;
      // Normalize WASD
      if (key === 'w' || key === 'W') keys['KeyW'] = false;
      if (key === 'a' || key === 'A') keys['KeyA'] = false;
      if (key === 's' || key === 'S') keys['KeyS'] = false;
      if (key === 'd' || key === 'D') keys['KeyD'] = false;
      // Normalize Arrows
      if (key === 'Up') keys['ArrowUp'] = false;
      if (key === 'Down') keys['ArrowDown'] = false;
      if (key === 'Left') keys['ArrowLeft'] = false;
      if (key === 'Right') keys['ArrowRight'] = false;
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  useEffect(() => {
    if (!socketRef.current || view !== 'game') return;

    let animFrame;
    let physicsInterval;

    const tickPhysics = () => {
      const state = gameStateRef.current;
      if (state?.matchState !== 'RUNNING' || !state.players[myId]?.isAlive) return;

      const keys = keysRef.current;
      let dx = 0, dy = 0;
      if (keys['ArrowUp']) dy -= 1;
      if (keys['ArrowDown']) dy += 1;
      if (keys['ArrowLeft']) dx -= 1;
      if (keys['ArrowRight']) dx += 1;

      // Fixed 30Hz Prediction
      const seq = ++nextSeqRef.current;
      const now = Date.now();
      
      // Store and emit even if static to maintain 1-to-1 tick sync
      pendingInputsRef.current.push({ dx, dy, seq, time: now });
      socketRef.current.emit('input_change', { dx, dy, seq });

      if (dx !== 0 || dy !== 0) {
        applyMovement(dx, dy, predictedPosRef.current, state.maze);
      }
    };

    const handleDiscreteInputs = () => {
      if (gameStateRef.current?.matchState !== 'RUNNING') {
        animFrame = requestAnimationFrame(handleDiscreteInputs);
        return;
      }

      const keys = keysRef.current;
      let vx = 0, vy = 0;
      if (keys['KeyW']) vy -= 1;
      if (keys['KeyS']) vy += 1;
      if (keys['KeyA']) vx -= 1;
      if (keys['KeyD']) vx += 1;

      const shootNow = Date.now();
      if ((vx !== 0 || vy !== 0) && shootNow - lastShootTimeRef.current > 200) {
        socketRef.current.emit('shoot', { 
          vx, 
          vy,
          x: predictedPosRef.current.x,
          y: predictedPosRef.current.y
        });
        playSound(600, 'square', 0.05, 0.1);
        lastShootTimeRef.current = shootNow;
      }

      animFrame = requestAnimationFrame(handleDiscreteInputs);
    };

    physicsInterval = setInterval(tickPhysics, 1000 / 30);
    animFrame = requestAnimationFrame(handleDiscreteInputs);

    return () => {
      clearInterval(physicsInterval);
      cancelAnimationFrame(animFrame);
    };
  }, [view]);

  // High-Speed Render Loop
  useEffect(() => {
    if (view !== 'game' || !canvasRef.current) return;

    let animFrame;
    const render = () => {
      animFrame = requestAnimationFrame(render);
      const currentState = gameStateRef.current;
      if (!currentState || !currentState.maze) return;

      const ctx = canvasRef.current.getContext('2d');
      const { players, snipes, matchState, countdown, maze, hives, bullets } = currentState;
      if (!maze || !players || !hives) return;

      const renderTime = Date.now() - INTERPOLATION_DELAY;
      const buffer = stateBufferRef.current;

      // Set canvas dimensions
      const MAZE_WIDTH = maze[0].length;
      const MAZE_HEIGHT = maze.length;
      canvasRef.current.width = MAZE_WIDTH * CELL_SIZE;
      canvasRef.current.height = MAZE_HEIGHT * CELL_SIZE;

      const isFlashing = Date.now() - flashTimeRef.current < 100;
      ctx.fillStyle = isFlashing ? '#300' : '#000';
      ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);

      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Draw Maze
      try {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        for (let y = 0; y < maze.length; y++) {
          for (let x = 0; x < maze[y].length; x++) {
            if (maze[y][x] === 1) {
              const top = y > 0 && maze[y - 1][x] === 1;
              const bottom = y < MAZE_HEIGHT - 1 && maze[y + 1][x] === 1;
              const left = x > 0 && maze[y][x - 1] === 1;
              const right = x < MAZE_WIDTH - 1 && maze[y][x + 1] === 1;
              ctx.beginPath();
              if (top) {
                ctx.moveTo(x * CELL_SIZE + CELL_SIZE / 2 - 2, y * CELL_SIZE);
                ctx.lineTo(x * CELL_SIZE + CELL_SIZE / 2 - 2, y * CELL_SIZE + CELL_SIZE / 2 - 2);
                ctx.moveTo(x * CELL_SIZE + CELL_SIZE / 2 + 2, y * CELL_SIZE);
                ctx.lineTo(x * CELL_SIZE + CELL_SIZE / 2 + 2, y * CELL_SIZE + CELL_SIZE / 2 - 2);
              }
              if (bottom) {
                ctx.moveTo(x * CELL_SIZE + CELL_SIZE / 2 - 2, y * CELL_SIZE + CELL_SIZE / 2 + 2);
                ctx.lineTo(x * CELL_SIZE + CELL_SIZE / 2 - 2, y * CELL_SIZE + CELL_SIZE);
                ctx.moveTo(x * CELL_SIZE + CELL_SIZE / 2 + 2, y * CELL_SIZE + CELL_SIZE / 2 + 2);
                ctx.lineTo(x * CELL_SIZE + CELL_SIZE / 2 + 2, y * CELL_SIZE + CELL_SIZE);
              }
              if (left) {
                ctx.moveTo(x * CELL_SIZE, y * CELL_SIZE + CELL_SIZE / 2 - 2);
                ctx.lineTo(x * CELL_SIZE + CELL_SIZE / 2 - 2, y * CELL_SIZE + CELL_SIZE / 2 - 2);
                ctx.moveTo(x * CELL_SIZE, y * CELL_SIZE + CELL_SIZE / 2 + 2);
                ctx.lineTo(x * CELL_SIZE + CELL_SIZE / 2 - 2, y * CELL_SIZE + CELL_SIZE / 2 + 2);
              }
              if (right) {
                ctx.moveTo(x * CELL_SIZE + CELL_SIZE / 2 + 2, y * CELL_SIZE + CELL_SIZE / 2 - 2);
                ctx.lineTo(x * CELL_SIZE + CELL_SIZE, y * CELL_SIZE + CELL_SIZE / 2 - 2);
                ctx.moveTo(x * CELL_SIZE + CELL_SIZE / 2 + 2, y * CELL_SIZE + CELL_SIZE / 2 + 2);
                ctx.lineTo(x * CELL_SIZE + CELL_SIZE, y * CELL_SIZE + CELL_SIZE / 2 + 2);
              }

              // Draw intersection block in the middle
              ctx.stroke();
              ctx.beginPath();
              ctx.strokeRect(x * CELL_SIZE + CELL_SIZE / 2 - 2, y * CELL_SIZE + CELL_SIZE / 2 - 2, 4, 4);
            }
          }
        }
      } catch (e) {
        console.error('Render error in maze:', e);
      }

      if (matchState === 'RUNNING' || matchState === 'GAME_OVER') {
        // Draw Hives
        ctx.fillStyle = '#0ff';
        if (hives) {
          hives.forEach(h => ctx.fillText('⌂', h.x * CELL_SIZE, h.y * CELL_SIZE));
        }

        // Draw Snipes
        if (snipes) {
          snipes.forEach(s => {
            const pos = getInterpolatedPosition(s.id, 'snipe', renderTime, buffer) || { x: s.x, y: s.y };
            if (s.type === 'fast') ctx.fillStyle = '#0ff'; // Cyan
            else if (s.type === 'shooter') ctx.fillStyle = '#f00'; // Red
            else ctx.fillStyle = '#f0f'; // Pink
            ctx.fillText('∩', pos.x * CELL_SIZE, pos.y * CELL_SIZE);
          });
        }

        // Draw Bullets
        ctx.fillStyle = '#fff';
        if (bullets) {
          bullets.forEach(b => ctx.fillText('·', b.x * CELL_SIZE, b.y * CELL_SIZE));
        }
      }

      // Draw Players
      Object.values(players).forEach(p => {
        const isLocal = p.id === myId;
        let renderX, renderY;

        if (isLocal) {
          renderX = predictedPosRef.current.x;
          renderY = predictedPosRef.current.y;
        } else {
          const interp = getInterpolatedPosition(p.id, 'player', renderTime, buffer);
          renderX = interp ? interp.x : p.x;
          renderY = interp ? interp.y : p.y;
        }

        ctx.fillStyle = isLocal ? '#0f0' : p.color;
        ctx.fillText('☻', renderX * CELL_SIZE, renderY * CELL_SIZE);
        ctx.font = '8px monospace';
        ctx.fillText(p.name, renderX * CELL_SIZE, renderY * CELL_SIZE - CELL_SIZE * 0.75);
        ctx.font = '10px monospace';
        if (p.health > 0) {
          ctx.fillStyle = '#0f0';
          ctx.fillText(`♥ ${p.health} | x${p.lives}`, renderX * CELL_SIZE, renderY * CELL_SIZE + 20);
        } else if (p.lives <= 0) {
          ctx.fillStyle = '#f00';
          ctx.fillText('ELIMINATED', renderX * CELL_SIZE, renderY * CELL_SIZE);
        } else {
          ctx.fillStyle = '#f00';
          ctx.fillText('DEAD', renderX * CELL_SIZE, renderY * CELL_SIZE);
        }
        ctx.font = FONT;
      });

      // Overlays
      if (matchState === 'STARTING') {
        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        ctx.fillStyle = '#0f0';
        ctx.font = '48px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`STARTING IN ${countdown}`, canvasRef.current.width / 2, canvasRef.current.height / 2);
      }

      if (matchState === 'GAME_OVER') {
        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        ctx.fillStyle = '#0f0';
        ctx.font = '48px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('MISSION COMPLETE', canvasRef.current.width / 2, canvasRef.current.height / 2 - 20);
        ctx.font = '24px monospace';
        ctx.fillText('ALL HIVES DESTROYED', canvasRef.current.width / 2, canvasRef.current.height / 2 + 40);
      }

      if (players[myId] && !players[myId].isAlive && matchState === 'RUNNING') {
        ctx.fillStyle = 'rgba(255,0,0,0.3)';
        ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        ctx.fillStyle = '#fff';
        ctx.font = '32px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('RESPAWNING...', canvasRef.current.width / 2, canvasRef.current.height / 2);
      }

    }; // end render
    animFrame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animFrame);
  }, [view, myId]);

  if (view === 'lobby') {
    return (
      <div className="App">
        <div className="game-container lobby">
          <h1>WEB SNIPES</h1>
          <form className="lobby-form" onSubmit={joinGame}>
            <input
              type="text"
              placeholder="ENTER NAME"
              value={name}
              onChange={(e) => setName(e.target.value.substring(0, 10).toUpperCase())}
              autoFocus
              disabled={serverFull}
            />
            {serverFull ? (
                <div style={{color: '#f00', marginTop: '10px', fontWeight: 'bold'}}>SERVER IS FULL (MAX {maxPlayers})</div>
            ) : (
                <button type="submit">JOIN GAME</button>
            )}
          </form>
          <div className="controls">
            <p>ARROWS: MOVE | WASD: SHOOT</p>
          </div>
        </div>
      </div>
    );
  }

  const localPlayer = gameState?.players[myId];

  return (
    <div className="App">
      <div className="game-container">
        <div className="game-header">
          <div className="player-stats">
            <div className="name-plate">{localPlayer?.name || '---'}</div>
            <div className="health-bar">
              <div className="health-fill" style={{ width: `${localPlayer?.health || 0}%` }}></div>
            </div>
            <div className="score-plate">SCORE: {localPlayer?.score || 0}</div>
            
            {/* Leaderboard Moved Next to Stats in Header */}
            <div className="leaderboard">
              {Object.values(gameState?.players || {})
                .sort((a, b) => b.score - a.score)
                .slice(0, 10)
                .map((p, i) => (
                  <div key={p.id} style={{ color: p.id === myId ? '#0f0' : p.color }}>
                    {i + 1}. {p.name}: {p.score}
                  </div>
                ))
              }
            </div>

          </div>
          
          <div className="game-info">
             <div className="mode-display">
               MODE: {gameMode} <br/>
               PLAYERS: {Object.keys(gameState?.players || {}).length}/{maxPlayers}
             </div>
             {isAdmin && matchState === 'LOBBY' && (
               <div className="admin-header-controls">
                 <button onClick={() => socketRef.current.emit('set_mode', gameMode === 'COOP' ? 'DEATHMATCH' : 'COOP')}>
                   TOGGLE MODE
                 </button>
                 <button className="start-btn" onClick={() => socketRef.current.emit('admin_start')}>START</button>
               </div>
             )}
              {isAdmin && matchState !== 'LOBBY' && (
                 <div className="admin-header-controls">
                     <button onClick={adminReset}>RESET</button>
                 </div>
              )}
          </div>
        </div>

        <canvas ref={canvasRef} />

        {matchState === 'LOBBY' && (
          <div className="lobby-overlay">
             <h2>WAITING FOR ADMIN TO START</h2>
             <p>PLAYERS CONNECTED: {Object.keys(gameState?.players || {}).length} of {maxPlayers}(max)</p>
          </div>
        )}

        {matchState === 'GAME_OVER' && (
          <div className="overlay-message">
            <h2>{gameOverReason || 'GAME OVER'}</h2>
            <p>Returning to lobby...</p>
          </div>
        )}

        <div className="footer-controls">
          ARROWS: MOVE | WASD: SHOOT
        </div>
      </div>
    </div>
  );
}
export default App;
