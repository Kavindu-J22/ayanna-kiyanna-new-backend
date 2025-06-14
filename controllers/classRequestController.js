const { validationResult } = require('express-validator');
const ClassRequest = require('../models/ClassRequest');
const Student = require('../models/Student');
const Class = require('../models/Class');
const Notification = require('../models/Notification');

// Create a new class enrollment request
exports.createClassRequest = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { classId, reason } = req.body;

    // Find student
    const student = await Student.findOne({ userId: req.user.id });
    if (!student) {
      return res.status(404).json({ message: 'Student profile not found' });
    }

    // Check if student is approved
    if (student.status !== 'Approved') {
      return res.status(400).json({ message: 'Student registration must be approved before requesting class enrollment' });
    }

    // Find class
    const classItem = await Class.findById(classId);
    if (!classItem) {
      return res.status(404).json({ message: 'Class not found' });
    }

    // Check if class is active and normal type
    if (!classItem.isActive || classItem.type !== 'Normal') {
      return res.status(400).json({ message: 'Class is not available for enrollment' });
    }

    // Check if already enrolled
    if (student.enrolledClasses && student.enrolledClasses.includes(classId)) {
      return res.status(400).json({ message: 'Already enrolled in this class' });
    }

    // Check if already has a pending request for this class
    const existingRequest = await ClassRequest.findOne({
      student: student._id,
      class: classId,
      status: 'Pending'
    });

    if (existingRequest) {
      return res.status(400).json({ message: 'You already have a pending request for this class' });
    }

    // Create class request
    const classRequest = new ClassRequest({
      student: student._id,
      class: classId,
      reason
    });

    await classRequest.save();

    // Populate the request for response
    await classRequest.populate([
      { path: 'student', select: 'studentId fullName' },
      { path: 'class', select: 'type grade date startTime endTime venue category' }
    ]);

    res.status(201).json({
      message: 'Class enrollment request submitted successfully',
      request: classRequest
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get student's class requests
exports.getStudentClassRequests = async (req, res) => {
  try {
    // Find student
    const student = await Student.findOne({ userId: req.user.id });
    if (!student) {
      return res.status(404).json({ message: 'Student profile not found' });
    }

    const requests = await ClassRequest.find({ student: student._id })
      .populate('class', 'type grade date startTime endTime venue category')
      .sort({ createdAt: -1 });

    res.json({
      requests
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get count of pending class requests (Admin)
exports.getPendingClassRequestsCount = async (req, res) => {
  try {
    const count = await ClassRequest.countDocuments({
      status: 'Pending'
    });

    res.json({
      success: true,
      count
    });
  } catch (err) {
    console.error('Error getting pending class requests count:', err.message);
    res.status(500).json({
      success: false,
      message: 'Server error while getting count'
    });
  }
};

// Get all class requests (Admin)
exports.getAllClassRequests = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, grade, search } = req.query;

    // Build filter object
    const filter = {};
    if (status) filter.status = status;

    let requests = await ClassRequest.find(filter)
      .populate({
        path: 'student',
        select: 'studentId firstName lastName selectedGrade email',
        options: { virtuals: true }
      })
      .populate('class', 'type grade date startTime endTime venue category')
      .populate('adminResponse.actionBy', 'fullName email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Filter by grade if specified
    if (grade) {
      requests = requests.filter(request => request.class.grade === grade);
    }

    // Filter by search term if specified
    if (search) {
      requests = requests.filter(request => {
        const studentName = `${request.student?.firstName || ''} ${request.student?.lastName || ''}`.toLowerCase();
        const studentId = request.student?.studentId?.toLowerCase() || '';
        const className = `${request.class?.grade || ''} ${request.class?.category || ''}`.toLowerCase();
        const searchTerm = search.toLowerCase();

        return studentName.includes(searchTerm) ||
               studentId.includes(searchTerm) ||
               className.includes(searchTerm) ||
               request.reason?.toLowerCase().includes(searchTerm);
      });
    }

    const total = await ClassRequest.countDocuments(filter);

    res.json({
      requests,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Approve class request (Admin)
exports.approveClassRequest = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { requestId } = req.params;
    const { adminNote } = req.body;

    const classRequest = await ClassRequest.findById(requestId)
      .populate({
        path: 'student',
        options: { virtuals: true }
      })
      .populate('class');

    if (!classRequest) {
      return res.status(404).json({ message: 'Class request not found' });
    }

    if (classRequest.status !== 'Pending') {
      return res.status(400).json({ message: 'Class request is not pending' });
    }

    // Check class capacity (account for the student being added)
    const enrolledCount = classRequest.class.enrolledStudents ? classRequest.class.enrolledStudents.length : 0;
    const isStudentAlreadyEnrolled = classRequest.class.enrolledStudents &&
      classRequest.class.enrolledStudents.some(id => id.equals(classRequest.student._id));

    // If student is not already enrolled, check if there's space for one more
    if (!isStudentAlreadyEnrolled && enrolledCount >= classRequest.class.capacity) {
      return res.status(400).json({ message: 'Class is at full capacity' });
    }

    // Update request status
    classRequest.status = 'Approved';
    classRequest.adminResponse = {
      actionBy: req.user.id,
      actionDate: new Date(),
      actionNote: adminNote || 'Request approved'
    };

    await classRequest.save();

    // Add student to class and class to student (with duplicate prevention)
    try {
      // Add student to class (only if not already enrolled)
      if (!classRequest.class.enrolledStudents) {
        classRequest.class.enrolledStudents = [];
      }
      if (!classRequest.class.enrolledStudents.some(id => id.equals(classRequest.student._id))) {
        classRequest.class.enrolledStudents.push(classRequest.student._id);
        await classRequest.class.save();
      }

      // Add class to student (only if not already enrolled)
      if (!classRequest.student.enrolledClasses) {
        classRequest.student.enrolledClasses = [];
      }
      if (!classRequest.student.enrolledClasses.some(id => id.equals(classRequest.class._id))) {
        classRequest.student.enrolledClasses.push(classRequest.class._id);
        await classRequest.student.save();
      }
    } catch (error) {
      console.error('Error enrolling student in class:', error);
      return res.status(500).json({ message: 'Error enrolling student in class' });
    }

    // Create notification for student
    try {
      await Notification.createNotification({
        recipient: classRequest.student.userId,
        type: 'class_request_approved',
        title: 'New Class Enrollment Request Approved! 🎉',
        message: `Your request to join ${classRequest.class.grade} - ${classRequest.class.category} class has been approved.`,
        data: {
          classRequestId: classRequest._id,
          classId: classRequest.class._id,
          adminNote: adminNote
        }
      });
    } catch (notificationError) {
      console.error('Error creating notification:', notificationError);
      // Continue even if notification fails
    }

    res.json({
      message: 'Class request approved successfully',
      request: classRequest
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Reject class request (Admin)
exports.rejectClassRequest = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { requestId } = req.params;
    const { adminNote } = req.body;

    const classRequest = await ClassRequest.findById(requestId)
      .populate({
        path: 'student',
        options: { virtuals: true }
      })
      .populate('class');

    if (!classRequest) {
      return res.status(404).json({ message: 'Class request not found' });
    }

    if (classRequest.status !== 'Pending') {
      return res.status(400).json({ message: 'Class request is not pending' });
    }

    // Update request status
    classRequest.status = 'Rejected';
    classRequest.adminResponse = {
      actionBy: req.user.id,
      actionDate: new Date(),
      actionNote: adminNote || 'Request rejected'
    };

    await classRequest.save();

    // Create notification for student
    await Notification.createNotification({
      recipient: classRequest.student.userId,
      type: 'class_request_rejected',
      title: 'Class Enrollment Request Update',
      message: `Your request to join ${classRequest.class.grade} - ${classRequest.class.category} class has been reviewed. Please contact administration for more information.`,
      data: {
        classRequestId: classRequest._id,
        classId: classRequest.class._id,
        adminNote: adminNote
      }
    });

    res.json({
      message: 'Class request rejected',
      request: classRequest
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Change class request status (Admin)
exports.changeClassRequestStatus = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    console.error('Validation errors:', errors.array());
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { requestId } = req.params;
    const { status, adminNote } = req.body;

    console.log('Changing class request status:', { requestId, status, adminNote });

    const classRequest = await ClassRequest.findById(requestId)
      .populate({
        path: 'student',
        options: { virtuals: true }
      })
      .populate('class');

    if (!classRequest) {
      return res.status(404).json({ message: 'Class request not found' });
    }

    const oldStatus = classRequest.status;

    // If changing from approved to rejected/pending, remove student from class
    if (oldStatus === 'Approved' && status !== 'Approved') {
      try {
        // Remove student from class
        if (classRequest.class && classRequest.class.enrolledStudents) {
          const originalLength = classRequest.class.enrolledStudents.length;
          classRequest.class.enrolledStudents = classRequest.class.enrolledStudents.filter(
            id => !id.equals(classRequest.student._id)
          );
          if (originalLength !== classRequest.class.enrolledStudents.length) {
            await classRequest.class.save();
          }
        }

        // Remove class from student
        if (classRequest.student && classRequest.student.enrolledClasses) {
          const originalLength = classRequest.student.enrolledClasses.length;
          classRequest.student.enrolledClasses = classRequest.student.enrolledClasses.filter(
            id => !id.equals(classRequest.class._id)
          );
          if (originalLength !== classRequest.student.enrolledClasses.length) {
            await classRequest.student.save();
          }
        }
      } catch (error) {
        console.error('Error removing student from class:', error);
        // Continue with status change even if removal fails
      }
    }

    // If changing from rejected/pending to approved, add student to class
    if (oldStatus !== 'Approved' && status === 'Approved') {
      try {
        // Check class capacity (account for the student being added)
        const enrolledCount = classRequest.class.enrolledStudents ? classRequest.class.enrolledStudents.length : 0;
        const isStudentAlreadyEnrolled = classRequest.class.enrolledStudents &&
          classRequest.class.enrolledStudents.some(id => id.equals(classRequest.student._id));

        // If student is not already enrolled, check if there's space for one more
        if (!isStudentAlreadyEnrolled && enrolledCount >= classRequest.class.capacity) {
          return res.status(400).json({ message: 'Class is at full capacity' });
        }

        // Add student to class (only if not already enrolled)
        if (!classRequest.class.enrolledStudents) {
          classRequest.class.enrolledStudents = [];
        }
        if (!classRequest.class.enrolledStudents.some(id => id.equals(classRequest.student._id))) {
          classRequest.class.enrolledStudents.push(classRequest.student._id);
          await classRequest.class.save();
        }

        // Add class to student (only if not already enrolled)
        if (!classRequest.student.enrolledClasses) {
          classRequest.student.enrolledClasses = [];
        }
        if (!classRequest.student.enrolledClasses.some(id => id.equals(classRequest.class._id))) {
          classRequest.student.enrolledClasses.push(classRequest.class._id);
          await classRequest.student.save();
        }
      } catch (error) {
        console.error('Error adding student to class:', error);
        return res.status(500).json({ message: 'Error enrolling student in class' });
      }
    }

    // Update request status
    classRequest.status = status;
    classRequest.adminResponse = {
      actionBy: req.user.id,
      actionDate: new Date(),
      actionNote: adminNote || `Status changed from ${oldStatus} to ${status}`
    };

    await classRequest.save();

    // Create notification for student
    try {
      await Notification.createNotification({
        recipient: classRequest.student.userId,
        type: 'class_request_status_change',
        title: 'Class Request Status Update',
        message: `Your class enrollment request status has been updated to ${status}.`,
        data: {
          classRequestId: classRequest._id,
          classId: classRequest.class._id,
          oldStatus: oldStatus,
          newStatus: status,
          adminNote: adminNote
        }
      });
    } catch (notificationError) {
      console.error('Error creating notification:', notificationError);
      // Continue even if notification fails
    }

    res.json({
      message: `Class request status changed from ${oldStatus} to ${status} successfully`,
      request: classRequest
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Approve all pending class requests (Admin)
exports.approveAllPendingRequests = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    console.error('Validation errors:', errors.array());
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { adminNote } = req.body;

    // Get all pending class requests
    const pendingRequests = await ClassRequest.find({ status: 'Pending' })
      .populate({
        path: 'student',
        options: { virtuals: true }
      })
      .populate('class');

    if (pendingRequests.length === 0) {
      return res.status(400).json({ message: 'No pending class requests found' });
    }

    let approvedCount = 0;
    let failedCount = 0;
    const failedRequests = [];

    // Process each pending request
    for (const classRequest of pendingRequests) {
      try {
        // Check class capacity (account for the student being added)
        const enrolledCount = classRequest.class.enrolledStudents ? classRequest.class.enrolledStudents.length : 0;
        const isStudentAlreadyEnrolled = classRequest.class.enrolledStudents &&
          classRequest.class.enrolledStudents.some(id => id.equals(classRequest.student._id));

        // If student is not already enrolled, check if there's space for one more
        if (!isStudentAlreadyEnrolled && enrolledCount >= classRequest.class.capacity) {
          failedCount++;
          failedRequests.push({
            studentName: `${classRequest.student.firstName} ${classRequest.student.lastName}`,
            className: `${classRequest.class.grade} - ${classRequest.class.category}`,
            reason: 'Class is at full capacity'
          });
          continue;
        }

        // Add student to class (only if not already enrolled)
        if (!classRequest.class.enrolledStudents) {
          classRequest.class.enrolledStudents = [];
        }
        if (!classRequest.class.enrolledStudents.some(id => id.equals(classRequest.student._id))) {
          classRequest.class.enrolledStudents.push(classRequest.student._id);
          await classRequest.class.save();
        }

        // Add class to student (only if not already enrolled)
        if (!classRequest.student.enrolledClasses) {
          classRequest.student.enrolledClasses = [];
        }
        if (!classRequest.student.enrolledClasses.some(id => id.equals(classRequest.class._id))) {
          classRequest.student.enrolledClasses.push(classRequest.class._id);
          await classRequest.student.save();
        }

        // Update request status
        classRequest.status = 'Approved';
        classRequest.adminResponse = {
          actionBy: req.user.id,
          actionDate: new Date(),
          actionNote: adminNote || 'Bulk approval by administrator'
        };

        await classRequest.save();

        // Create notification for student
        try {
          await Notification.createNotification({
            recipient: classRequest.student.userId,
            type: 'class_request_approved',
            title: 'Class Request Approved',
            message: `Your class enrollment request for ${classRequest.class.grade} - ${classRequest.class.category} has been approved.`,
            data: {
              classRequestId: classRequest._id,
              classId: classRequest.class._id,
              adminNote: adminNote
            }
          });
        } catch (notificationError) {
          console.error('Error creating notification:', notificationError);
          // Continue even if notification fails
        }

        approvedCount++;
      } catch (error) {
        console.error(`Error approving request for student ${classRequest.student._id}:`, error);
        failedCount++;
        failedRequests.push({
          studentName: `${classRequest.student.firstName} ${classRequest.student.lastName}`,
          className: `${classRequest.class.grade} - ${classRequest.class.category}`,
          reason: 'Processing error'
        });
      }
    }

    let message = `Successfully approved ${approvedCount} class requests`;
    if (failedCount > 0) {
      message += `. ${failedCount} requests failed to approve.`;
    }

    res.json({
      message,
      approvedCount,
      failedCount,
      failedRequests: failedCount > 0 ? failedRequests : undefined
    });
  } catch (err) {
    console.error('Error in approveAllPendingRequests:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Delete class request (Student)
exports.deleteClassRequest = async (req, res) => {
  try {
    const { requestId } = req.params;

    // Find student
    const student = await Student.findOne({ userId: req.user.id });
    if (!student) {
      return res.status(404).json({ message: 'Student profile not found' });
    }

    // Find the class request
    const classRequest = await ClassRequest.findById(requestId)
      .populate('class', 'grade category');

    if (!classRequest) {
      return res.status(404).json({ message: 'Class request not found' });
    }

    // Check if the request belongs to the student
    if (!classRequest.student.equals(student._id)) {
      return res.status(403).json({ message: 'You can only delete your own class requests' });
    }

    // Only allow deletion of pending requests
    if (classRequest.status !== 'Pending') {
      return res.status(400).json({ message: 'You can only delete pending class requests' });
    }

    // Delete the request
    await ClassRequest.findByIdAndDelete(requestId);

    res.json({
      message: 'Class request deleted successfully'
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Delete class request (Admin)
exports.adminDeleteClassRequest = async (req, res) => {
  try {
    const { requestId } = req.params;

    // Find the class request
    const classRequest = await ClassRequest.findById(requestId)
      .populate('student', 'firstName lastName studentId')
      .populate('class', 'grade category');

    if (!classRequest) {
      return res.status(404).json({ message: 'Class request not found' });
    }

    // If the request was approved, remove student from class
    if (classRequest.status === 'Approved') {
      try {
        const classItem = await Class.findById(classRequest.class._id);
        if (classItem && classItem.enrolledStudents) {
          classItem.enrolledStudents = classItem.enrolledStudents.filter(
            id => !id.equals(classRequest.student._id)
          );
          await classItem.save();
        }

        // Remove class from student's enrolled classes
        const student = await Student.findById(classRequest.student._id);
        if (student && student.enrolledClasses) {
          student.enrolledClasses = student.enrolledClasses.filter(
            id => !id.equals(classRequest.class._id)
          );
          await student.save();
        }
      } catch (error) {
        console.error('Error removing student from class during deletion:', error);
        // Continue with deletion even if removal fails
      }
    }

    // Create notification for student
    try {
      await Notification.createNotification({
        recipient: classRequest.student.userId || classRequest.student._id,
        type: 'general',
        title: 'Class Request Deleted',
        message: `Your class enrollment request for ${classRequest.class.grade} - ${classRequest.class.category} has been deleted by an administrator.`,
        data: {
          classRequestId: classRequest._id,
          classId: classRequest.class._id,
          adminNote: 'Request deleted by administrator'
        }
      });
    } catch (notificationError) {
      console.error('Error creating notification for deleted class request:', notificationError);
      // Continue with deletion even if notification fails
    }

    // Delete the request
    await ClassRequest.findByIdAndDelete(requestId);

    res.json({
      message: 'Class request deleted successfully',
      deletedRequest: {
        studentName: `${classRequest.student.firstName} ${classRequest.student.lastName}`,
        className: `${classRequest.class.grade} - ${classRequest.class.category}`,
        status: classRequest.status
      }
    });
  } catch (err) {
    console.error('Error in adminDeleteClassRequest:', err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = exports;
