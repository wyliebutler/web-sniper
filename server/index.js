const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3001;

// Game State
const gameState = {
    matchState: 'LOBBY', // LOBBY, STARTING, RUNNING, GAME_OVER
    gameMode: 'COOP', // COOP, DEATHMATCH
    countdown: 0,
    players: {},
    snipes: [],
    hives: [],
    bullets: [],
    maze: [],
    lastUpdateTime: Date.now(),
    matchStartTime: 0
};

// Maze Constants
const MAZE_WIDTH = 41;  // Scale down grid bounds since gaps are wider
const MAZE_HEIGHT = 21;

function resetGame() {
    gameState.snipes = [];
    gameState.bullets = [];
    gameState.hives = [];
    spawnHives(15);
    gameState.matchStartTime = Date.now();
    gameState.maze = generateMaze();
    Object.values(gameState.players).forEach(p => {
        p.score = 0;
        p.health = 100;
        p.lives = 3;
        p.isAlive = true;

        let px, py;
        do {
            px = Math.floor(Math.random() * (MAZE_WIDTH - 2)) + 1;
            py = Math.floor(MAZE_HEIGHT / 2);
        } while (gameState.maze[py][px] === 1);
        p.x = px + 0.5;
        p.y = py + 0.5;
        p.dx = 0;
        p.dy = 0;
    });
}

function generateMaze() {
    const maze = Array(MAZE_HEIGHT).fill().map(() => Array(MAZE_WIDTH).fill(1));
    function carve(x, y) {
        maze[y][x] = 0;
        const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]].sort(() => Math.random() - 0.5);
        for (const [dx, dy] of dirs) {
            // Carve wider paths by jumping and carving out multiple cells
            const nx = x + dx * 2, ny = y + dy * 2;
            if (ny > 0 && ny < MAZE_HEIGHT - 1 && nx > 0 && nx < MAZE_WIDTH - 1 && maze[ny][nx] === 1) {
                maze[y + dy][x + dx] = 0;
                // Optional: make rooms slightly wider by carving adjacent cells 
                // if it doesn't break the outer wall bounds.
                carve(nx, ny);
            }
        }
    }
    carve(1, 1);
    return maze;
}

gameState.maze = generateMaze();

function spawnHives(count) {
    for (let i = 0; i < count; i++) {
        let x, y;
        do {
            // Spawn strictly inside the map away from borders (3 to MAZE_WIDTH/HEIGHT - 4)
            // ensuring odd-odd coordinates puts them directly in the center of pathway junctions
            x = Math.floor(Math.random() * (MAZE_WIDTH - 6)) + 3;
            y = Math.floor(Math.random() * (MAZE_HEIGHT - 6)) + 3;
        } while (gameState.maze[y][x] === 1 || x % 2 === 0 || y % 2 === 0);
        gameState.hives.push({ id: `hive-${i}`, x: x + 0.5, y: y + 0.5, health: 3 });
    }
}

function spawnSnipesPerHive() {
    if (gameState.matchState !== 'RUNNING') return;

    // Scale max snipes over time too (start small, grow to 30)
    const elapsedSecs = (Date.now() - gameState.matchStartTime) / 1000;
    const currentMaxSnipes = Math.min(30, 3 + Math.floor(elapsedSecs / 5));
    if (gameState.snipes.length >= currentMaxSnipes) return;

    // Wake up 1 additional hive every 20 seconds of gameplay
    const activeHiveCount = Math.min(gameState.hives.length, 1 + Math.floor(elapsedSecs / 20));

    // Only process the currently "awake" hives
    for (let i = 0; i < activeHiveCount; i++) {
        const hive = gameState.hives[i];
        if (hive.health > 0) {
            let type = 'basic';
            const rnd = Math.random();
            if (rnd > 0.8) type = 'shooter';
            else if (rnd > 0.6) type = 'fast';

            gameState.snipes.push({
                id: `snipe-${Date.now()}-${Math.random()}`,
                x: hive.x,
                y: hive.y,
                vx: 0,
                vy: 0,
                type: type,
                lastShot: 0
            });
        }
    }
}

spawnHives(15);
setInterval(spawnSnipesPerHive, 5000); // 5 seconds spawn wave, but limited by awake hives

function updateEntities() {
    if (gameState.matchState !== 'RUNNING') return;

    // Update Snipes with simple Hunting AI
    gameState.snipes.forEach(snipe => {
        // Find nearest player
        let target = null;
        let minDist = 15; // Awareness radius
        Object.values(gameState.players).forEach(p => {
            if (!p.isAlive) return;
            const d = Math.sqrt((p.x - snipe.x) ** 2 + (p.y - snipe.y) ** 2);
            if (d < minDist) {
                minDist = d;
                target = p;
            }
        });

        if (target) {
            const dx = target.x - snipe.x;
            const dy = target.y - snipe.y;
            const mag = Math.sqrt(dx * dx + dy * dy);

            const speed = snipe.type === 'fast' ? 0.1 : 0.05;
            snipe.vx = (dx / mag) * speed;
            snipe.vy = (dy / mag) * speed;

            // Shooter Snipes fire if they have aggro
            if (snipe.type === 'shooter' && Date.now() - (snipe.lastShot || 0) > 2000) {
                snipe.lastShot = Date.now();
                gameState.bullets.push({
                    x: snipe.x,
                    y: snipe.y,
                    vx: (dx / mag) * 0.2, // Enemy bullets are slower than player bullets
                    vy: (dy / mag) * 0.2,
                    ownerId: 'enemy'
                });
            }
        } else {
            // Random meandering
            if (Math.random() < 0.05) {
                const speed = snipe.type === 'fast' ? 0.1 : 0.05;
                const angle = Math.random() * Math.PI * 2;
                snipe.vx = Math.cos(angle) * speed;
                snipe.vy = Math.sin(angle) * speed;
            }
        }

        let nextX = snipe.x + snipe.vx;
        const gxX = Math.floor(nextX);
        const gyX = Math.floor(snipe.y);

        if (gameState.maze[gyX] && gameState.maze[gyX][gxX] === 0) {
            snipe.x = nextX;
        } else {
            if (!target) snipe.vx *= -1; // Only bounce if wandering blindly
        }

        let nextY = snipe.y + snipe.vy;
        const gxY = Math.floor(snipe.x);
        const gyY = Math.floor(nextY);

        if (gameState.maze[gyY] && gameState.maze[gyY][gxY] === 0) {
            snipe.y = nextY;
        } else {
            if (!target) snipe.vy *= -1;
        }
    });

    gameState.bullets = gameState.bullets.filter(bullet => {
        let prevX = bullet.x;
        let prevY = bullet.y;

        bullet.x += bullet.vx;
        bullet.y += bullet.vy;

        let gx = Math.floor(bullet.x);
        let gy = Math.floor(bullet.y);

        // Wall Collision & Rebounding
        if (gameState.maze[gy] && gameState.maze[gy][gx] === 1) {
            bullet.bounces--;
            if (bullet.bounces < 0) return false;

            // Determine flip axis by checking which previous axis crosses the boundary
            let prevGx = Math.floor(prevX);
            let prevGy = Math.floor(prevY);

            // If we hit a horizontal wall (Y crossed boundary into a wall block)
            if (prevGy !== gy && gameState.maze[gy][prevGx] === 1) {
                bullet.vy *= -1;
                bullet.y = prevY + bullet.vy; // Snap back appropriately
            }
            // If we hit a vertical wall (X crossed boundary into a wall block)
            else if (prevGx !== gx && gameState.maze[prevGy][gx] === 1) {
                bullet.vx *= -1;
                bullet.x = prevX + bullet.vx;
            }
            // Corner hit or fallback
            else {
                bullet.vx *= -1;
                bullet.vy *= -1;
                bullet.x = prevX + bullet.vx;
                bullet.y = prevY + bullet.vy;
            }

            // Recalculate grid pos after bounce
            gx = Math.floor(bullet.x);
            gy = Math.floor(bullet.y);
            // If it miraculously bounced into another wall (stuck), kill it
            if (gameState.maze[gy] && gameState.maze[gy][gx] === 1) return false;
        }

        let hit = false;

        // Checking against players
        Object.values(gameState.players).forEach(p => {
            if (!p.isAlive || hit) return;
            // Don't hit yourself, unless it's an enemy bullet
            if (p.id === bullet.ownerId) return;

            // Only take PvP damage if deathmatch is on, but ALWAYS take Enemy Bullet damage
            if (bullet.ownerId !== 'enemy' && gameState.gameMode !== 'DEATHMATCH') return;

            const dist = Math.sqrt((bullet.x - p.x) ** 2 + (bullet.y - p.y) ** 2);
            if (dist < 0.7) {
                hit = true;
                p.health -= 25;
                checkPlayerDeath(p, bullet.ownerId === 'enemy' ? null : bullet.ownerId);
            }
        });

        if (hit) return false;
        gameState.snipes = gameState.snipes.filter(snipe => {
            const dist = Math.sqrt((bullet.x - snipe.x) ** 2 + (bullet.y - snipe.y) ** 2);
            if (dist < 0.8) {
                if (bullet.ownerId === 'enemy') return true; // Friendly fire disabled for swarms

                hit = true;
                if (gameState.players[bullet.ownerId]) {
                    // Different points for harder variants
                    let pts = 10;
                    if (snipe.type === 'fast') pts = 15;
                    else if (snipe.type === 'shooter') pts = 25;
                    gameState.players[bullet.ownerId].score += pts;
                }
                return false;
            }
            return true;
        });

        if (hit) return false;

        gameState.hives = gameState.hives.filter(hive => {
            const dist = Math.sqrt((bullet.x - hive.x) ** 2 + (bullet.y - hive.y) ** 2);
            if (dist < 1) {
                hive.health -= 1;
                hit = true;
                if (hive.health <= 0) {
                    if (gameState.players[bullet.ownerId]) gameState.players[bullet.ownerId].score += 100;
                    return false;
                }
            }
            return true;
        });

        if (hit) return false;
        if (hit) return false;
        return bullet.x > 0 && bullet.x < MAZE_WIDTH && bullet.y > 0 && bullet.y < MAZE_HEIGHT;
    });
}

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    let px, py;
    do {
        px = Math.floor(Math.random() * (MAZE_WIDTH - 2)) + 1;
        py = Math.floor(MAZE_HEIGHT / 2);
    } while (gameState.maze[py][px] === 1);

    gameState.players[socket.id] = {
        id: socket.id,
        name: "Guest",
        x: px + 0.5,
        y: py + 0.5,
        dx: 0,
        dy: 0,
        score: 0,
        health: 100,
        lives: 3,
        isAlive: true,
        color: '#' + Math.floor(Math.random() * 16777215).toString(16)
    };

    socket.on('join', (data) => {
        const player = gameState.players[socket.id];
        if (player) {
            player.name = data.name || "Guest";
            player.isAlive = true;
            player.health = 100;
            player.lives = 3;
            player.dx = 0;
            player.dy = 0;
        }
    });

    socket.on('set_mode', (mode) => {
        if (gameState.matchState === 'LOBBY' && (mode === 'COOP' || mode === 'DEATHMATCH')) {
            gameState.gameMode = mode;
            gameState.countdown = 3;
            gameState.matchStartTime = 0;
            io.emit('stateUpdate', { gameMode: gameState.gameMode, countdown: gameState.countdown });
        }
    });

    socket.on('admin_start', () => {
        console.log('Admin started match');
        if (gameState.matchState === 'LOBBY') {
            gameState.matchState = 'STARTING';
            gameState.countdown = 5;
            const timer = setInterval(() => {
                gameState.countdown--;
                if (gameState.countdown <= 0) {
                    clearInterval(timer);
                    gameState.matchState = 'RUNNING';
                    gameState.matchStartTime = Date.now();
                    console.log('Match state: RUNNING. Resetting game entities...');
                    resetGame();
                    // Explicitly emit maze to everyone on start
                    io.emit('stateUpdate', { maze: gameState.maze, matchState: gameState.matchState });
                } else {
                    io.emit('stateUpdate', { matchState: gameState.matchState, countdown: gameState.countdown });
                }
            }, 1000);
        }
    });

    socket.on('admin_reset', () => {
        console.log('Admin reset match');
        gameState.matchState = 'LOBBY';
        resetGame();
        io.emit('stateUpdate', { maze: gameState.maze, matchState: gameState.matchState });
    });

    socket.emit('init', {
        maze: gameState.maze,
        players: gameState.players,
        hives: gameState.hives,
        matchState: gameState.matchState,
        id: socket.id
    });

    socket.on('input_change', (data) => {
        const player = gameState.players[socket.id];
        if (player && player.isAlive && gameState.matchState === 'RUNNING') {
            player.dx = data.dx || 0;
            player.dy = data.dy || 0;
        }
    });

    socket.on('shoot', (data) => {
        const player = gameState.players[socket.id];
        if (player && player.isAlive && gameState.matchState === 'RUNNING') {

            // Normalize velocity for diagonal shooting
            let mag = Math.sqrt(data.vx * data.vx + data.vy * data.vy);
            if (mag === 0) return;

            let speedX = (data.vx / mag) * 0.4;
            let speedY = (data.vy / mag) * 0.4;

            gameState.bullets.push({
                x: player.x,
                y: player.y,
                vx: speedX,
                vy: speedY,
                ownerId: socket.id,
                bounces: 1 // Bullets can rebound off 1 wall
            });
            socket.broadcast.emit('player_shoot', { id: socket.id });
        }
    });

    socket.on('disconnect', () => {
        delete gameState.players[socket.id];
    });
});

// Centralized death checking
function checkPlayerDeath(player, killerId = null) {
    if (player.health <= 0 && player.isAlive) {
        player.isAlive = false;
        player.health = 0;
        player.lives -= 1;

        if (killerId && gameState.players[killerId]) {
            gameState.players[killerId].score += 50; // Points for a PvP kill
        } else {
            player.score = Math.max(0, player.score - 50); // Lose points for dying to Snipes
        }

        if (player.lives > 0) {
            setTimeout(() => {
                if (gameState.matchState !== 'RUNNING') return;
                let rx, ry;
                do {
                    rx = Math.floor(Math.random() * (MAZE_WIDTH - 2)) + 1;
                    ry = Math.floor(MAZE_HEIGHT / 2);
                } while (gameState.maze[ry][rx] === 1);
                player.x = rx + 0.5;
                player.y = ry + 0.5;
                player.dx = 0;
                player.dy = 0;
                player.health = 100;
                player.isAlive = true;
            }, 3000);
        }
    }
}

// Check for Game Over Conditions
function checkWinConditions() {
    if (gameState.matchState !== 'RUNNING') return;

    if (gameState.gameMode === 'COOP') {
        // COOP Win: All hives dead
        if (gameState.hives.length === 0) {
            endMatch('ALL HIVES DESTROYED');
            return;
        }

        // COOP Loss: All players out of lives
        const anyAlive = Object.values(gameState.players).some(p => p.lives > 0);
        if (!anyAlive && Object.keys(gameState.players).length > 0) {
            endMatch('ALL PLAYERS ELIMINATED');
        }
    } else if (gameState.gameMode === 'DEATHMATCH') {
        // DEATHMATCH End: Only 1 player with lives remaining (or testing solo)
        const playersWithLives = Object.values(gameState.players).filter(p => p.lives > 0);
        if (playersWithLives.length <= 1 && Object.keys(gameState.players).length > 1) {
            let topPlayer = Object.values(gameState.players).sort((a, b) => b.score - a.score)[0];
            endMatch(`${topPlayer.name} WINS!`);
        } else if (playersWithLives.length === 0 && Object.keys(gameState.players).length === 1) {
            endMatch('GAME OVER');
        }
    }
}

function endMatch(reason) {
    console.log(`Match Ended: ${reason}`);
    gameState.matchState = 'GAME_OVER';
    io.emit('gameOver', { reason });
    setTimeout(() => {
        gameState.matchState = 'LOBBY';
        resetGame();
    }, 10000);
}

function updatePlayers() {
    if (gameState.matchState !== 'RUNNING') return;
    Object.values(gameState.players).forEach(player => {
        if (!player.isAlive) return;

        // --- Continuous Velocity Physics ---
        const speed = 0.2; // Increase speed slightly to compensate for bigger grid
        let dx = (player.dx || 0) * speed;
        let dy = (player.dy || 0) * speed;

        const playerSize = 0.35; // A radius, making the player 0.7x0.7 cells large

        // Fluid grid movement: check center-based target cell
        if (dx !== 0) {
            const targetX = player.x + Math.sign(dx) * playerSize + dx;
            const gx = Math.floor(targetX);
            const gy = Math.floor(player.y);

            if (gameState.maze[gy] && gameState.maze[gy][gx] === 0) {
                player.x += dx;
            } else if (dx > 0) {
                player.x = Math.floor(player.x) + 1 - playerSize;
            } else if (dx < 0) {
                player.x = Math.ceil(player.x - 0.5) + playerSize;
            }

            // Auto-align Y if not actively moving vertically
            if (dy === 0) {
                const centerY = gy + 0.5;
                const diffY = centerY - player.y;
                if (Math.abs(diffY) > 0.001) {
                    player.y += Math.sign(diffY) * Math.min(Math.abs(diffY), speed * 0.75);
                }
            }
        }

        if (dy !== 0) {
            const targetY = player.y + Math.sign(dy) * playerSize + dy;
            const gy = Math.floor(targetY);
            const gx = Math.floor(player.x);

            if (gameState.maze[gy] && gameState.maze[gy][gx] === 0) {
                player.y += dy;
            } else if (dy > 0) {
                player.y = Math.floor(player.y) + 1 - playerSize;
            } else if (dy < 0) {
                player.y = Math.ceil(player.y - 0.5) + playerSize;
            }

            // Auto-align X if not actively moving horizontally
            if (dx === 0) {
                const centerX = gx + 0.5;
                const diffX = centerX - player.x;
                if (Math.abs(diffX) > 0.001) {
                    player.x += Math.sign(diffX) * Math.min(Math.abs(diffX), speed * 0.75);
                }
            }
        }
        // --- /Continuous Velocity Physics ---

        gameState.snipes.forEach(snipe => {
            const dist = Math.sqrt((player.x - snipe.x) ** 2 + (player.y - snipe.y) ** 2);
            if (dist < 0.7) {
                player.health -= 0.5;
                checkPlayerDeath(player);
            }
        });
    });
}

// Game Loop (30Hz)
setInterval(() => {
    updateEntities();
    updatePlayers();
    checkWinConditions();
    gameState.lastUpdateTime = Date.now();
    io.emit('stateUpdate', {
        matchState: gameState.matchState,
        countdown: gameState.countdown,
        players: gameState.players,
        snipes: gameState.snipes,
        hives: gameState.hives,
        bullets: gameState.bullets
    });
}, 1000 / 30);

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
