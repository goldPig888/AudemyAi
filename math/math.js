const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const util = require('util');
const textToSpeech = require('@google-cloud/text-to-speech');
const speech = require('@google-cloud/speech');
const w2n = require('words-to-numbers');
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

function checkAnswer(userAnswer, correctAnswer) {
    let numericUserAnswer = parseInt(userAnswer, 10);

    if (isNaN(numericUserAnswer)) {
        numericUserAnswer = w2n.wordsToNumbers(userAnswer);
    }

    return numericUserAnswer === correctAnswer;
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

const generateMathProblem = async (difficulty, gameMode) => {
    let prompt;

    if (difficulty === 'easy') {
        prompt = `
            Generate a simple ${gameMode} problem with two single-digit numbers.
            Present the problem in the format in words: "What is <problem>?". 
            Include the correct answer in this format at the end: "Answer: <answer>."
        `;
    } else if (difficulty === 'medium') {
        prompt = `
            Generate an medium ${gameMode} problem with two two-digit numbers.
            Present the problem in the format in words: "What is <problem>?". 
            Include the correct answer in this format at the end: "Answer: <answer>."
        `;
    } else {
        prompt =
        `
            Generate an hard ${gameMode} problem with three two-digit numbers.
            Present the problem in the format in words: "What is <problem>?". 
            Include the correct answer in this format at the end: "Answer: <answer>."
        `;
    }

    const response = await openai.completions.create({
        model: "gpt-3.5-turbo-instruct",
        prompt: prompt,
        max_tokens: 150,
        temperature: 0.5
    });

    const generatedText = response.choices[0].text.trim();

    const questionMatch = generatedText.match(/What is (.+?)\?/);
    const answerMatch = generatedText.match(/Answer: (\d+)/);

    if (!questionMatch || !answerMatch) {
        throw new Error('Invalid GPT response format');
    }

    return { question: questionMatch[0], answer: parseInt(answerMatch[1], 10) };
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

    if (!['addition', 'subtraction', 'multiplication', 'division'].includes(gameMode)) {
        return res.status(400).json({ error: 'Invalid game mode' });
    }

    try {
        totalGamesPlayed = parseInt(cookies[`${gameMode}_totalGames`]) || totalGamesPlayed;
        correctAnswers = parseInt(cookies[`${gameMode}_correctAnswers`]) || correctAnswers;

        const accuracy = (totalGamesPlayed === 0) ? 50 : ((correctAnswers / totalGamesPlayed) * 100).toFixed(2);
        const difficulty = determineDifficulty(accuracy);

        const { question, answer } = await generateMathProblem(difficulty, gameMode);
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
        const isCorrect = checkAnswer(userAnswer, correctAnswer);
        const feedbackAudioPath = getPreRecordedAudio(isCorrect ? 'correct' : 'incorrect');

        let currentRoundCounted = cookies['currentRoundCounted'] === 'true';

        if (!currentRoundCounted) {
            totalGamesPlayed++;
            res.cookie('currentRoundCounted', true, { maxAge: 3600000, path: '/' });
        }

        if (isCorrect) correctAnswers++;

        const accuracy = (totalGamesPlayed > 0) ? ((correctAnswers / totalGamesPlayed) * 100).toFixed(2) : 50;

        res.json({
            feedback: isCorrect ? "That's correct!" : "That's incorrect!",
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



app.post('/cleanup-audio-output', (req, res) => {
    const outputDir = path.join(__dirname, 'audio', 'output');
    fs.readdir(outputDir, (err, files) => {
        if (err) {
            console.error(`Error reading output directory: ${err}`);
            return res.status(500).send('Error cleaning up files');
        }

        files.forEach(file => {
            const filePath = path.join(outputDir, file);
            if (!lastQuestionAudioFile.includes(file) && !lastFeedbackAudioFile.includes(file)) {
                fs.unlink(filePath, err => {
                    if (err) console.error(`Error deleting file ${filePath}:`, err);
                });
            }
        });
    });

    res.sendStatus(200);
});

app.get('/no-input-audio', (req, res) => {
    const noInputAudioPath = getPreRecordedAudio('no_input');
    const browserAccessiblePath = noInputAudioPath.replace(path.join(__dirname, 'audio'), '/audio');
    res.json({ noInputAudioPath: browserAccessiblePath });
});

app.get('/end-game', (req, res) => {
    const gameMode = req.query.gameMode;

    const accuracy = ((correctAnswers / totalGamesPlayed) * 100).toFixed(2);

    const responseObject = {
        totalGamesPlayed,
        correctAnswers,
        accuracy
    };

    if (gameMode && ['addition', 'subtraction', 'multiplication', 'division'].includes(gameMode)) {
        res.cookie(`${gameMode}_totalGames`, totalGamesPlayed, { maxAge: 31536000, httpOnly: false, path: '/' });
        res.cookie(`${gameMode}_correctAnswers`, correctAnswers, { maxAge: 31536000, httpOnly: false, path: '/' });
        res.cookie(`${gameMode}_accuracy`, accuracy, { maxAge: 31536000, httpOnly: false, path: '/' });
    }

    res.json(responseObject);
});


app.get('/repeat-audio', (req, res) => {
    if (lastQuestionAudioFile) {
        const browserAccessiblePath = lastQuestionAudioFile.replace(path.join(__dirname, 'audio'), '/audio');
        res.json({ audioPath: browserAccessiblePath });
    } else {
        res.status(404).json({ error: 'No audio available to repeat' });
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
