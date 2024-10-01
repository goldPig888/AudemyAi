const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const util = require('util');
const textToSpeech = require('@google-cloud/text-to-speech');
const speech = require('@google-cloud/speech');
const OpenAI = require('openai');

require('dotenv').config();

const app = express();
const port = 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const credentials = JSON.parse(fs.readFileSync('credentials.json'));
const clientTTS = new textToSpeech.TextToSpeechClient({ credentials });
const clientSTT = new speech.SpeechClient({ credentials });

let totalGamesPlayed = 0;
let correctAnswers = 0;
let lastQuestionAudioFile = '';
let lastFeedbackAudioFile = '';

app.use(express.static('public'));
app.use('/audio', express.static(path.join(__dirname, 'audio')));
app.use(bodyParser.json());

const getPreRecordedAudio = (type) => {
    const utilAudioDir = path.join(__dirname, 'audio', 'util');
    switch (type) {
        case 'correct': return path.join(utilAudioDir, 'correct.mp3');
        case 'incorrect': return path.join(utilAudioDir, 'incorrect.mp3');
        case 'instructions': return path.join(utilAudioDir, 'instructions.mp3');
        case 'no_input': return path.join(utilAudioDir, 'no_input.mp3');
        default: throw new Error('Invalid audio type');
    }
}

function checkAnswer(userAnswer, correctAnswer, gameMode) {
    const sanitize = (input) => input.replace(/[^a-zA-Z]/g, '').toLowerCase();

    const sanitizedUserAnswer = sanitize(userAnswer);
    const sanitizedCorrectAnswer = sanitize(correctAnswer);

    console.log('Sanitized User Answer:', sanitizedUserAnswer);
    console.log('Sanitized Correct Answer:', sanitizedCorrectAnswer);

    if (gameMode === 'spelling') {
        if (!userAnswer.includes(' ')) {
            
            return { result: false, message: "You should spell the word, not say it out loud." };
        }

        if (sanitizedUserAnswer === sanitizedCorrectAnswer) {
            return { result: true };
        } else {
            return { result: false, message: "Incorrect spelling." };
        }
    }

    if (gameMode === 'odd_one_out' || gameMode === 'vocabulary') {
        return { result: sanitizedUserAnswer === sanitizedCorrectAnswer };
    } else if (gameMode === 'story_builder') {
        return { result: sanitizedUserAnswer.includes(sanitizedCorrectAnswer) };
    }

    throw new Error('Invalid game mode');
}





const synthesizeSpeech = async (text) => {
    const outputDir = path.join(__dirname, 'audio', 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const request = {
        input: { text },
        voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
        audioConfig: { audioEncoding: 'MP3' }
    };

    const [response] = await clientTTS.synthesizeSpeech(request);
    const audioFileName = `output_${Date.now()}.mp3`;
    const audioPath = path.join(outputDir, audioFileName);
    await util.promisify(fs.writeFile)(audioPath, response.audioContent, 'binary');
    return `/audio/output/${audioFileName}`;
};

const generateGamePrompt = async (gameMode, difficulty) => {
    let prompt;

    switch (gameMode) {
        case 'spelling':
            prompt = `
                Generate a ${difficulty} spelling question. 
                Provide a word for the player to spell. Do not include "Answer".
                Only provide the word to be spelled, like this: "Spell the word <word>."
            `;
            break;
        case 'odd_one_out':
            prompt = `
                Generate a ${difficulty} odd-one-out question. 
                Provide 4 words, with one word that is different. Format the output as:
                "Which one is the odd one out: <word1>, <word2>, <word3>, <word4>? Answer: <odd word>"
            `;
            break;
        case 'story_builder':
            prompt = `
                Generate a ${difficulty} sentence for a story-building game. 
                Format the output as:
                "Continue the story: <sentence>. Answer: <correct continuation>"
            `;
            break;
        case 'vocabulary':
            prompt = `
                Generate a ${difficulty} vocabulary question.
                Provide a definition and the correct word. Format as:
                "What word fits the definition: <definition>? Answer: <word>"
            `;
            break;
        default:
            throw new Error('Invalid game mode');
    }

    const response = await openai.completions.create({
        model: "gpt-3.5-turbo-instruct",
        prompt: prompt,
        max_tokens: 150,
        temperature: 0.5
    });

    const generatedText = response.choices[0].text.trim();

    let question, answer;

    if (gameMode === 'odd_one_out') {
        question = generatedText.match(/Which one is the odd one out:(.+?)\?/)[0];
        answer = generatedText.match(/Answer: \s*(.+)/)[1].trim();
    } else {
        question = generatedText.match(/(.+?)$/)[0];
        answer = question.split(" ")[3]; 
    }

    return { question, answer };
};



const deleteOldAudioFiles = async () => {
    const outputDir = path.join(__dirname, 'audio', 'output');
    fs.readdir(outputDir, (err, files) => {
        if (err) {
            console.error('Error reading output directory:', err);
            return;
        }
        
        files.forEach(file => {
            const filePath = path.join(outputDir, file);
            if (lastQuestionAudioFile !== filePath && lastFeedbackAudioFile !== filePath) {
                fs.unlink(filePath, err => {
                    if (err) console.error(`Error deleting file ${filePath}:`, err);
                    else console.log(`Deleted old audio file: ${filePath}`);
                });
            }
        });
    });
}

const determineDifficulty = (accuracy) => {
    if (accuracy > 80) return 'hard';
    if (accuracy > 50) return 'medium';
    return 'easy';
};

function getCookies(req) {
    const cookies = {};
    req.headers.cookie?.split(';').forEach(cookie => {
        const [name, value] = cookie.split('=').map(item => item.trim());
        cookies[name] = decodeURIComponent(value);
    });
    return cookies;
}

app.get('/start-game/:gameMode', async (req, res) => {
    const gameMode = req.params.gameMode;
    const cookies = getCookies(req);

    if (!['spelling', 'odd_one_out', 'story_builder', 'vocabulary'].includes(gameMode)) {
        return res.status(400).json({ error: 'Invalid game mode' });
    }

    try {
        totalGamesPlayed = parseInt(cookies[`${gameMode}_totalGames`]) || totalGamesPlayed;
        correctAnswers = parseInt(cookies[`${gameMode}_correctAnswers`]) || correctAnswers;

        const accuracy = (totalGamesPlayed === 0) ? 50 : ((correctAnswers / totalGamesPlayed) * 100).toFixed(2);
        const difficulty = determineDifficulty(accuracy);

        const { question, answer } = await generateGamePrompt(gameMode, difficulty);
        await deleteOldAudioFiles();
        const audioFilePath = await synthesizeSpeech(question);

        lastQuestionAudioFile = path.join(__dirname, 'audio', 'output', path.basename(audioFilePath));

        res.cookie('currentRoundCounted', false, { maxAge: 3600000, path: '/' });
        
        res.json({ question, answer, audioPath: audioFilePath });
    } catch (error) {
        console.error('Error during start game:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/submit-answer', async (req, res) => {
    try {
        const { audioBytes, correctAnswer, gameMode } = req.body;
        const cookies = getCookies(req);

        if (!audioBytes || audioBytes.trim() === '') {
            throw new Error('Invalid or empty user answer');
        }

        const userAnswer = audioBytes.trim();
        console.log("User Answer:", userAnswer);
        console.log("Correct Answer:", correctAnswer);

        const { result, message } = checkAnswer(userAnswer, correctAnswer, gameMode);

        const feedbackAudioPath = getPreRecordedAudio(result ? 'correct' : 'incorrect');
        let currentRoundCounted = cookies['currentRoundCounted'] === 'true';

        if (!currentRoundCounted) {
            totalGamesPlayed++;
            res.cookie('currentRoundCounted', true, { maxAge: 3600000, path: '/' });
        }

        if (result) correctAnswers++;

        const accuracy = (totalGamesPlayed > 0) ? ((correctAnswers / totalGamesPlayed) * 100).toFixed(2) : 50;

        res.json({
            feedback: result ? "That's correct!" : message || "That's incorrect!",
            feedbackAudioPath: `/audio/util/${path.basename(feedbackAudioPath)}`,
            accuracy,
            totalGamesPlayed,
            correctAnswers
        });
    } catch (error) {
        console.error('Error processing answer:', error);
        res.status(500).json({ error: error.message });
    }
});




app.get('/end-game', (req, res) => {
    const gameMode = req.query.gameMode;

    const accuracy = ((correctAnswers / totalGamesPlayed) * 100).toFixed(2);

    const responseObject = {
        totalGamesPlayed,
        correctAnswers,
        accuracy
    };

    if (gameMode && ['spelling', 'odd_one_out', 'story_builder', 'vocabulary'].includes(gameMode)) {
        res.cookie(`${gameMode}_totalGames`, totalGamesPlayed, { maxAge: 31536000, httpOnly: false, path: '/' });
        res.cookie(`${gameMode}_correctAnswers`, correctAnswers, { maxAge: 31536000, httpOnly: false, path: '/' });
        res.cookie(`${gameMode}_accuracy`, accuracy, { maxAge: 31536000, httpOnly: false, path: '/' });
    }

    res.json(responseObject);
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
