const express = require('express');
const bodyParser = require('body-parser');
const textToSpeech = require('@google-cloud/text-to-speech');
const speech = require('@google-cloud/speech');
const fs = require('fs');
const util = require('util');
const path = require('path');
const mathGame = require('./games/mathGame');

const app = express();
const port = 3000;

let totalGamesPlayed = 0;
let correctAnswers = 0;
let lastQuestionAudioFile = '';
let lastFeedbackAudioFile = '';

app.use(express.static('public'));
app.use('/audio', express.static(path.join(__dirname, 'audio')));

const credentials = JSON.parse(fs.readFileSync('credentials.json'));
const clientTTS = new textToSpeech.TextToSpeechClient({ credentials });
const clientSTT = new speech.SpeechClient({ credentials });

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
};

const synthesizeSpeech = async (text) => {
    const outputDir = path.join(__dirname, 'audio', 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const request = {
        input: { text },
        voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
        audioConfig: { audioEncoding: 'MP3' },
    };
    const [response] = await clientTTS.synthesizeSpeech(request);
    const audioFileName = `output_${Date.now()}.mp3`;
    const audioPath = path.join(outputDir, audioFileName);
    const writeFile = util.promisify(fs.writeFile);
    await writeFile(audioPath, response.audioContent, 'binary');
    return `/audio/output/${audioFileName}`;
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
};

app.get('/start-game', async (req, res) => {
    try {
        const game = mathGame.start();
        await deleteOldAudioFiles();
        const audioFilePath = await synthesizeSpeech(game.question);
        console.log('Sending question with audio path:', audioFilePath);
        lastQuestionAudioFile = path.join(__dirname, 'audio', 'output', audioFilePath.split('/').pop());
        totalGamesPlayed++;
        res.json({ question: game.question, answer: game.answer, audioPath: audioFilePath });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/submit-answer', async (req, res) => {
    try {
        const { audioBytes, correctAnswer } = req.body;
        if (!audioBytes || audioBytes.trim() === '') {
            throw new Error('Invalid or empty user answer');
        }

        const userAnswer = audioBytes.trim();
        const isCorrect = parseInt(userAnswer) === correctAnswer;
        const feedbackAudioPath = getPreRecordedAudio(isCorrect ? 'correct' : 'incorrect');

        if (isCorrect) correctAnswers++;

        console.log(`Is the answer correct?: ${isCorrect}`);
        console.log('Serving pre-recorded feedback audio:', feedbackAudioPath);

        lastFeedbackAudioFile = feedbackAudioPath;

        const accuracy = ((correctAnswers / totalGamesPlayed) * 100).toFixed(2);
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

app.get('/repeat-audio', (req, res) => {
    if (lastQuestionAudioFile) {
        const browserAccessiblePath = lastQuestionAudioFile.replace(path.join(__dirname, 'audio'), '/audio');
        res.json({ audioPath: browserAccessiblePath });
    } else {
        res.status(404).json({ error: 'No audio available to repeat' });
    }
});

app.post('/cleanup-audio-output', (req, res) => {
    const outputDir = path.join(__dirname, 'audio', 'output');
    fs.readdir(outputDir, (err, files) => {
        if (err) {
            console.error('Error reading output directory:', err);
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
    const accuracy = ((correctAnswers / totalGamesPlayed) * 100).toFixed(2);
    res.json({
        totalGamesPlayed,
        correctAnswers,
        accuracy
    });
    totalGamesPlayed = 0;
    correctAnswers = 0;
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
