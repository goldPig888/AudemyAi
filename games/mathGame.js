// games/mathGame.js

// Generate a random math problem for addition
const generateMathProblem = () => {
    const num1 = Math.floor(Math.random() * 100);
    const num2 = Math.floor(Math.random() * 100);
    return {
        question: `What is ${num1} plus ${num2}?`,
        answer: num1 + num2
    };
};

module.exports = {
    start: generateMathProblem
};
