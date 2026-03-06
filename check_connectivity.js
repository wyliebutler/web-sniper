const fs = require('fs');

const MAZE_WIDTH = 40;
const MAZE_HEIGHT = 20;

function generateMaze() {
    const maze = Array(MAZE_HEIGHT).fill().map(() => Array(MAZE_WIDTH).fill(1));
    function carve(x, y) {
        maze[y][x] = 0;
        const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]].sort(() => Math.random() - 0.5);
        for (const [dx, dy] of dirs) {
            const nx = x + dx * 2, ny = y + dy * 2;
            if (ny > 0 && ny < MAZE_HEIGHT - 1 && nx > 0 && nx < MAZE_WIDTH - 1 && maze[ny][nx] === 1) {
                maze[y + dy][x + dx] = 0;
                carve(nx, ny);
            }
        }
    }
    carve(1, 1);
    return maze;
}

const maze = generateMaze();

let numZeros = 0;
let startX = -1;
let startY = -1;

for (let y = 0; y < MAZE_HEIGHT; y++) {
    for (let x = 0; x < MAZE_WIDTH; x++) {
        if (maze[y][x] === 0) {
            numZeros++;
            if (startX === -1) {
                startX = x;
                startY = y;
            }
        }
    }
}

let visited = 0;
const stack = [[startX, startY]];
const seen = Array(MAZE_HEIGHT).fill().map(() => Array(MAZE_WIDTH).fill(false));
seen[startY][startX] = true;

const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];

while (stack.length > 0) {
    const [x, y] = stack.pop();
    visited++;

    for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < MAZE_WIDTH && ny >= 0 && ny < MAZE_HEIGHT && maze[ny][nx] === 0 && !seen[ny][nx]) {
            seen[ny][nx] = true;
            stack.push([nx, ny]);
        }
    }
}

console.log(`Total 0s: ${numZeros}`);
console.log(`Visited 0s: ${visited}`);
if (numZeros === visited) {
    console.log("SUCCESS: All reachable areas are connected.");
} else {
    console.log("FAILURE: There are disconnected areas.");
}
