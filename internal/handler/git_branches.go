package handler

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/go-git/go-git/v6"
	"github.com/go-git/go-git/v6/plumbing"
)

type BranchInfo struct {
	Name      string `json:"name"`
	IsCurrent bool   `json:"isCurrent"`
}

func (h *GitHandler) Branches(c *gin.Context) {
	var req GitPathRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repo, err := h.openRepo(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	head, err := repo.Head()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	currentBranch := ""
	if head.Name().IsBranch() {
		currentBranch = head.Name().Short()
	}

	branches, err := repo.Branches()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var branchList []BranchInfo
	err = branches.ForEach(func(ref *plumbing.Reference) error {
		branchName := ref.Name().Short()
		branchList = append(branchList, BranchInfo{
			Name:      branchName,
			IsCurrent: branchName == currentBranch,
		})
		return nil
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"branches":      branchList,
		"currentBranch": currentBranch,
	})
}

type SwitchBranchRequest struct {
	Path   string `json:"path" binding:"required"`
	Branch string `json:"branch" binding:"required"`
}

func (h *GitHandler) SwitchBranch(c *gin.Context) {
	var req SwitchBranchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repo, err := h.openRepo(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	w, err := repo.Worktree()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	branchRefName := plumbing.NewBranchReferenceName(req.Branch)
	
	ref, err := repo.Reference(branchRefName, true)
	if err != nil {
		if err == plumbing.ErrReferenceNotFound {
			c.JSON(http.StatusBadRequest, gin.H{"error": "branch not found: " + req.Branch})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	err = w.Checkout(&git.CheckoutOptions{
		Branch: ref.Name(),
	})
	if err != nil {
		if strings.Contains(err.Error(), "worktree contains unstaged changes") {
			c.JSON(http.StatusBadRequest, gin.H{"error": "cannot switch branch: you have unstaged changes"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "branch": req.Branch})
}
