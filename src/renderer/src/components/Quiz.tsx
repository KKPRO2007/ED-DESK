import React, { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApp } from '../App'

interface QuizQuestion {
  id: string
  question: string
  options: string[]
  correctAnswer: number
  explanation?: string
  category: string
  difficulty: 'easy' | 'medium' | 'hard'
  points: number
  timeLimit?: number // seconds per question
}

interface QuizSession {
  id: string
  title: string
  description: string
  questions: QuizQuestion[]
  timeLimit?: number // total minutes
  shuffleQuestions: boolean
  showAnswers: boolean
  allowReview: boolean
  createdBy: string
  participants: { userId: string; score: number; completed: boolean }[]
}

export default function QuizSystem() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const { currentUser, deviceInfo } = useApp()
  
  const [quizzes, setQuizzes] = useState<QuizSession[]>([])
  const [activeQuiz, setActiveQuiz] = useState<QuizSession | null>(null)
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0)
  const [userAnswers, setUserAnswers] = useState<number[]>([])
  const [quizStarted, setQuizStarted] = useState(false)
  const [quizCompleted, setQuizCompleted] = useState(false)
  const [score, setScore] = useState(0)
  const [timeLeft, setTimeLeft] = useState<number>(0)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')

  // Sample quiz data
  useEffect(() => {
    const sampleQuizzes: QuizSession[] = [
      {
        id: 'quiz-1',
        title: 'Data Structures & Algorithms',
        description: 'Test your knowledge of fundamental DSA concepts',
        questions: [
          {
            id: 'q1',
            question: 'What is the time complexity of binary search?',
            options: ['O(n)', 'O(log n)', 'O(n²)', 'O(1)'],
            correctAnswer: 1,
            explanation: 'Binary search repeatedly divides the search interval in half',
            category: 'algorithms',
            difficulty: 'easy',
            points: 10
          },
          {
            id: 'q2',
            question: 'Which data structure uses LIFO principle?',
            options: ['Queue', 'Stack', 'Array', 'Linked List'],
            correctAnswer: 1,
            explanation: 'Stack follows Last In First Out principle',
            category: 'data-structures',
            difficulty: 'easy',
            points: 10
          },
          {
            id: 'q3',
            question: 'What is the worst-case time complexity of quicksort?',
            options: ['O(n log n)', 'O(n²)', 'O(n)', 'O(log n)'],
            correctAnswer: 1,
            explanation: 'Quicksort has O(n²) worst-case when pivot is poorly chosen',
            category: 'algorithms',
            difficulty: 'medium',
            points: 15
          },
          {
            id: 'q4',
            question: 'Which of the following is a balanced binary search tree?',
            options: ['Binary Tree', 'AVL Tree', 'B-Tree', 'Heap'],
            correctAnswer: 1,
            explanation: 'AVL tree maintains balance through rotations',
            category: 'trees',
            difficulty: 'medium',
            points: 15
          },
          {
            id: 'q5',
            question: 'What is the space complexity of DFS?',
            options: ['O(1)', 'O(log n)', 'O(n)', 'O(n²)'],
            correctAnswer: 2,
            explanation: 'DFS uses stack space proportional to the depth of the tree',
            category: 'algorithms',
            difficulty: 'hard',
            points: 20
          }
        ],
        timeLimit: 15,
        shuffleQuestions: true,
        showAnswers: true,
        allowReview: true,
        createdBy: 'Prof. Sharma',
        participants: []
      },
      {
        id: 'quiz-2',
        title: 'JavaScript Fundamentals',
        description: 'Test your JavaScript knowledge',
        questions: [
          {
            id: 'q6',
            question: 'What is closure in JavaScript?',
            options: [
              'A function with access to its outer scope',
              'A way to close browser window',
              'A type of loop',
              'An error handling mechanism'
            ],
            correctAnswer: 0,
            explanation: 'Closure is a function that remembers its outer variables',
            category: 'javascript',
            difficulty: 'medium',
            points: 15
          },
          {
            id: 'q7',
            question: 'Which keyword is used to declare a constant in ES6?',
            options: ['var', 'let', 'const', 'static'],
            correctAnswer: 2,
            explanation: 'const declares block-scoped constants',
            category: 'javascript',
            difficulty: 'easy',
            points: 10
          }
        ],
        timeLimit: 10,
        shuffleQuestions: true,
        showAnswers: true,
        allowReview: true,
        createdBy: 'Prof. Verma',
        participants: []
      }
    ]
    setQuizzes(sampleQuizzes)
  }, [])

  const startQuiz = (quiz: QuizSession) => {
    const shuffled = quiz.shuffleQuestions 
      ? [...quiz.questions].sort(() => Math.random() - 0.5)
      : quiz.questions
    
    setActiveQuiz({ ...quiz, questions: shuffled })
    setQuizStarted(true)
    setQuizCompleted(false)
    setCurrentQuestionIndex(0)
    setUserAnswers([])
    setScore(0)
    setTimeLeft((quiz.timeLimit || 0) * 60)
  }

  const handleAnswer = (answerIndex: number) => {
    const newAnswers = [...userAnswers]
    newAnswers[currentQuestionIndex] = answerIndex
    setUserAnswers(newAnswers)

    // Auto-calculate score if correct
    if (activeQuiz) {
      const isCorrect = answerIndex === activeQuiz.questions[currentQuestionIndex].correctAnswer
      if (isCorrect) {
        setScore(score + activeQuiz.questions[currentQuestionIndex].points)
      }
    }
  }

  const nextQuestion = () => {
    if (activeQuiz && currentQuestionIndex < activeQuiz.questions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1)
    } else {
      setQuizCompleted(true)
      // Save participant result
      if (activeQuiz && currentUser) {
        setQuizzes(quizzes.map(q => {
          if (q.id === activeQuiz.id) {
            return {
              ...q,
              participants: [
                ...q.participants,
                { userId: currentUser.id, score, completed: true }
              ]
            }
          }
          return q
        }))
      }
    }
  }

  const prevQuestion = () => {
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex(currentQuestionIndex - 1)
    }
  }

  // Timer effect
  useEffect(() => {
    if (quizStarted && !quizCompleted && timeLeft > 0) {
      const timer = setInterval(() => {
        setTimeLeft(prev => {
          if (prev <= 1) {
            setQuizCompleted(true)
            return 0
          }
          return prev - 1
        })
      }, 1000)
      return () => clearInterval(timer)
    }
  }, [quizStarted, quizCompleted, timeLeft])

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const filteredQuizzes = quizzes.filter(quiz =>
    (selectedCategory === 'all' || quiz.questions.some(q => q.category === selectedCategory)) &&
    (searchQuery ? quiz.title.toLowerCase().includes(searchQuery.toLowerCase()) : true)
  )

  const categories = ['all', ...new Set(quizzes.flatMap(q => q.questions.map(qq => qq.category)))]

  // Quiz taking view
  if (quizStarted && activeQuiz && !quizCompleted) {
    const currentQuestion = activeQuiz.questions[currentQuestionIndex]
    const progress = ((currentQuestionIndex + 1) / activeQuiz.questions.length) * 100

    return (
      <div className="quiz-taking">
        <div className="quiz-header">
          <h2>{activeQuiz.title}</h2>
          <div className="quiz-timer">
            <span className="timer-icon">⏱️</span>
            <span className="timer-value">{formatTime(timeLeft)}</span>
          </div>
        </div>

        <div className="quiz-progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="question-counter">
            Question {currentQuestionIndex + 1} of {activeQuiz.questions.length}
          </span>
        </div>

        <div className="question-container">
          <div className="question-header">
            <span className="difficulty-badge">{currentQuestion.difficulty}</span>
            <span className="points">{currentQuestion.points} points</span>
          </div>

          <h3 className="question-text">{currentQuestion.question}</h3>

          <div className="options-grid">
            {currentQuestion.options.map((option, index) => {
              const isSelected = userAnswers[currentQuestionIndex] === index
              const isCorrect = quizCompleted && index === currentQuestion.correctAnswer
              
              return (
                <button
                  key={index}
                  className={`option-btn ${isSelected ? 'selected' : ''} ${quizCompleted && isCorrect ? 'correct' : ''}`}
                  onClick={() => handleAnswer(index)}
                  disabled={userAnswers[currentQuestionIndex] !== undefined}
                >
                  <span className="option-letter">{String.fromCharCode(65 + index)}</span>
                  <span className="option-text">{option}</span>
                </button>
              )
            })}
          </div>

          {userAnswers[currentQuestionIndex] !== undefined && currentQuestion.explanation && (
            <div className="explanation">
              <h4>Explanation:</h4>
              <p>{currentQuestion.explanation}</p>
            </div>
          )}
        </div>

        <div className="quiz-navigation">
          <button
            className="btn btn-secondary"
            onClick={prevQuestion}
            disabled={currentQuestionIndex === 0}
          >
            ← Previous
          </button>
          
          <button
            className="btn btn-primary"
            onClick={nextQuestion}
            disabled={userAnswers[currentQuestionIndex] === undefined}
          >
            {currentQuestionIndex === activeQuiz.questions.length - 1 ? 'Finish Quiz' : 'Next →'}
          </button>
        </div>
      </div>
    )
  }

  // Quiz results view
  if (quizCompleted && activeQuiz) {
    const totalPoints = activeQuiz.questions.reduce((sum, q) => sum + q.points, 0)
    const percentage = (score / totalPoints) * 100

    return (
      <div className="quiz-results">
        <h2>Quiz Complete!</h2>
        
        <div className="score-card">
          <div className="score-circle">
            <span className="score-value">{score}</span>
            <span className="score-total">/{totalPoints}</span>
          </div>
          <div className="score-details">
            <div className="detail-item">
              <span>Correct Answers:</span>
              <span>{userAnswers.filter((ans, idx) => ans === activeQuiz.questions[idx].correctAnswer).length}</span>
            </div>
            <div className="detail-item">
              <span>Total Questions:</span>
              <span>{activeQuiz.questions.length}</span>
            </div>
            <div className="detail-item">
              <span>Percentage:</span>
              <span>{percentage.toFixed(1)}%</span>
            </div>
          </div>
        </div>

        {activeQuiz.allowReview && (
          <div className="review-section">
            <h3>Review Answers</h3>
            {activeQuiz.questions.map((q, idx) => {
              const userAnswer = userAnswers[idx]
              const isCorrect = userAnswer === q.correctAnswer
              
              return (
                <div key={q.id} className={`review-item ${isCorrect ? 'correct' : 'incorrect'}`}>
                  <div className="review-question">
                    <span className="question-num">Q{idx + 1}</span>
                    <span className="question-text">{q.question}</span>
                  </div>
                  <div className="review-answer">
                    <span>Your answer: {q.options[userAnswer]}</span>
                    {!isCorrect && (
                      <span className="correct-answer">
                        Correct: {q.options[q.correctAnswer]}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <div className="results-actions">
          <button className="btn btn-secondary" onClick={() => setQuizStarted(false)}>
            Back to Quizzes
          </button>
          <button className="btn btn-primary" onClick={() => startQuiz(activeQuiz)}>
            Take Again
          </button>
        </div>
      </div>
    )
  }

  // Quiz list view
  return (
    <div className="quiz-system">
      <div className="quiz-header">
        <h1>Quizzes & Assessments</h1>
        <div className="quiz-stats">
          <span className="stat">📚 {quizzes.length} Available</span>
          <span className="stat">👥 {deviceInfo.nearbyDevices.length} Participants</span>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
          <span className="btn-icon">+</span> Create Quiz
        </button>
      </div>

      <div className="quiz-filters">
        <div className="search-bar">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            placeholder="Search quizzes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <select value={selectedCategory} onChange={(e) => setSelectedCategory(e.target.value)}>
          {categories.map(cat => (
            <option key={cat} value={cat}>
              {cat === 'all' ? 'All Categories' : cat}
            </option>
          ))}
        </select>
      </div>

      <div className="quizzes-grid">
        {filteredQuizzes.map(quiz => {
          const totalPoints = quiz.questions.reduce((sum, q) => sum + q.points, 0)
          const avgDifficulty = quiz.questions.reduce((sum, q) => {
            const difficultyMap = { easy: 1, medium: 2, hard: 3 }
            return sum + difficultyMap[q.difficulty]
          }, 0) / quiz.questions.length

          return (
            <div key={quiz.id} className="quiz-card">
              <div className="quiz-card-header">
                <h3>{quiz.title}</h3>
                <span className="difficulty-indicator">
                  {'⭐'.repeat(Math.round(avgDifficulty))}
                </span>
              </div>

              <p className="quiz-description">{quiz.description}</p>

              <div className="quiz-meta">
                <div className="meta-item">
                  <span className="meta-label">Questions:</span>
                  <span className="meta-value">{quiz.questions.length}</span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Total Points:</span>
                  <span className="meta-value">{totalPoints}</span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Time Limit:</span>
                  <span className="meta-value">{quiz.timeLimit} min</span>
                </div>
              </div>

              <div className="quiz-categories">
                {Array.from(new Set(quiz.questions.map(q => q.category))).map(cat => (
                  <span key={cat} className="category-tag">{cat}</span>
                ))}
              </div>

              <div className="quiz-card-footer">
                <span className="creator">By {quiz.createdBy}</span>
                <button 
                  className="btn btn-primary"
                  onClick={() => startQuiz(quiz)}
                >
                  Start Quiz
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Create Quiz Modal - Similar to Assessment creator but simplified */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content large" onClick={e => e.stopPropagation()}>
            <h2>Create New Quiz</h2>
            <p className="text-secondary">Quiz creation interface would go here</p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowCreateModal(false)}>
                Cancel
              </button>
              <button className="btn btn-primary">Create Quiz</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}