const MAZE_WIDTH = 41;
const MAZE_HEIGHT = 21;

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

const maze = generateMaze();
for (let y = 0; y < MAZE_HEIGHT; y++) {
    let row = '';
    for (let x = 0; x < MAZE_WIDTH; x++) {
        row += maze[y][x] === 1 ? 'X' : '.';
    }
    console.log(row);
}
